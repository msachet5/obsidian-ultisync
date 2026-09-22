import {
	apiVersion,
	App,
	ButtonComponent,
	Plugin,
	PluginSettingTab,
	Setting,
	setIcon,
} from 'obsidian';
import type { SettingDefinitionItem, SettingDefinitionRender } from 'obsidian';
import {
	ConnectionState,
	UltiSyncSettings,
	PHASE_VERB,
	PUSH_DELAY_SECONDS,
	SUPPORTED_EXTENSIONS,
	SyncProgress,
	SyncStatus,
	progressPercent,
} from '../types';
import { devicePlatform } from '../platform';
import { usesSecretStorage } from '../TokenStore';
import { normalizeExtension, normalizePath } from '../vault/PathFilter';
import { BUG_ICON } from './icons';

/** The credential fields, which are edited as a draft and applied by Save. */
export type CredentialDraft = Pick<
	UltiSyncSettings,
	'githubOwner' | 'githubRepo' | 'branch' | 'token'
>;

/** What the settings tab needs from the plugin, kept narrow deliberately. */
export interface SettingsHost {
	settings: UltiSyncSettings;
	saveSettings(): Promise<void>;
	/** Persists the credentials, then runs the setup check against the repo. */
	applyCredentials(draft: CredentialDraft): Promise<void>;
	/** Turning this on re-runs the setup check. */
	setSyncEnabled(enabled: boolean): Promise<void>;
	hasCredentials(): boolean;
	getConnectionState(): ConnectionState;
	/** Asks before clearing credentials and sync bookkeeping. */
	confirmReset(): void;
	/** Resolves once the push, and any linking it needed first, is over. */
	pushNow(): Promise<void>;
	resetSyncState(): Promise<void>;
	getDeviceId(): string;
	getStatus(): { status: SyncStatus; detail?: string };
	/** How far the transfer in flight has got, or null when it has no count. */
	getProgress(): SyncProgress | null;
	/** Whether a transfer or comparison is running, whoever started it. */
	isBusy(): boolean;
}

/** The two long-running actions, which show their progress in their button. */
type Action = 'push' | 'reset';

const ACTION_LABEL: Record<Action, { idle: string; busy: string }> = {
	push: { idle: 'Push', busy: 'Pushing' },
	reset: { idle: 'Reset and re-pull', busy: 'Resetting' },
};

/** How often a working button is repainted while nothing else drives it. */
const BUTTON_TICK_MS = 100;

/**
 * One row of the tab, described once and rendered by either path: Obsidian
 * 1.13 renders from `getSettingDefinitions()`, older versions from `display()`.
 * Keeping the name and description here rather than inside `build` is what
 * lets 1.13 index the row for settings search without the two paths drifting.
 */
interface RowSpec {
	name: string;
	desc?: string;
	/** Extra search terms, used only by the declarative path. */
	aliases?: string[];
	/**
	 * Fills in the controls; the name and description are already applied.
	 * Returns whatever the fluent Setting API hands back, which is ignored —
	 * the same shape Obsidian's own component callbacks use.
	 */
	build: (setting: Setting) => unknown;
}

/** A heading with its rows, rendered as a group in the declarative path. */
interface SectionSpec {
	heading?: string;
	/** Fixed classes, safe to set once when the section is first created. */
	cls?: string;
	/**
	 * Whether the section is currently out of play. Kept apart from `cls`
	 * because it changes between renders: 1.13 matches groups by heading and
	 * reuses their elements, applying `cls` only to the ones it has just
	 * created, so a class added there is never taken off again.
	 */
	dimmed?: boolean;
	rows: RowSpec[];
}

const PAT_STEPS = [
	'Open GitHub and click your profile picture, then Settings. Scroll to the bottom of the left-hand menu for Developer settings.',
	'Under Personal access tokens, choose Fine-grained tokens.',
	'Click Generate new token. Give it a name you will recognise later. The description is optional.',
	'Set the expiry. "No expiration" keeps it working indefinitely; a shorter one is fine for testing, and you can always generate a new token afterwards.',
	'Under Repository access, choose Only select repositories and pick the repository you are syncing to. Do not grant access to all repositories.',
	'Open Repository permissions, find Contents, and set it to Read and write. Nothing else is needed.',
	'Click Generate token, then copy the token. GitHub shows it only once.',
	'Paste it into the field above and click Save.',
];

const REPO_URL = 'https://github.com/msachet5/obsidian-ultisync';

export class SettingsTab extends PluginSettingTab {
	private draft: CredentialDraft;
	private saving = false;

	// Carried into a bug report, so nobody has to be asked which version broke.
	private readonly version: string;

	// Held so the button can be updated through its own API. Obsidian's
	// setDisabled also toggles a class that blocks pointer events, so reaching
	// past the component and clearing the disabled property alone leaves a
	// button that looks enabled and cannot be clicked.
	private saveButton: ButtonComponent | null = null;

	// The action in flight, and the buttons that show it. Held on the tab
	// rather than the row: the tab survives a redraw, the row does not, and a
	// push that started before the settings were reopened is still running.
	private action: Action | null = null;
	private actionButtons: Partial<Record<Action, ButtonComponent>> = {};
	private actionTimer: number | null = null;

	constructor(
		app: App,
		private host: SettingsHost,
		plugin: Plugin,
	) {
		super(app, plugin);
		this.version = plugin.manifest.version;
		this.draft = this.draftFromSettings();
	}

	// ---------------------------------------------------------------------
	// Entry points
	// ---------------------------------------------------------------------

	/**
	 * Obsidian 1.13 and later render the tab from these and index them for
	 * settings search. Returning a non-empty array means display() is never
	 * called on those versions.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		this.beginRender();

		const definitions: SettingDefinitionItem[] = [
			{
				name: 'UltiSync',
				aliases: ['connection', 'status', 'reset credentials'],
				render: (setting) => {
					const el = this.asBlock(setting);
					this.renderHeader(el);
					this.renderIntro(el);
				},
			},
		];

		for (const section of this.sections()) {
			definitions.push({
				type: 'group',
				heading: section.heading,
				cls: section.cls,
				items: section.rows.map(
					(row): SettingDefinitionRender => ({
						name: row.name,
						desc: row.desc,
						aliases: row.aliases,
						// Row renders re-run on every repaint, which is what lets
						// the gate come back off a group element that 1.13 is
						// reusing rather than rebuilding.
						render: (setting) => {
							this.applyGate(setting, section.dimmed);
							row.build(setting);
						},
					}),
				),
			});
		}

		return definitions;
	}

	/**
	 * The pre-1.13 fallback. Obsidian 1.13 and later ignore it in favour of
	 * getSettingDefinitions(), so every change has to be made to the shared
	 * specs rather than here.
	 */
	display(): void {
		this.renderImperative();
	}

	/** Repaints after something outside the tab changed the state it shows. */
	refresh(): void {
		this.redraw();
	}

	private renderImperative(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.beginRender();

		this.renderHeader(containerEl);
		this.renderIntro(containerEl);

		for (const section of this.sections()) {
			const sectionEl = containerEl.createDiv();
			if (section.cls) sectionEl.addClass(section.cls);
			sectionEl.toggleClass('ultisync-dimmed', Boolean(section.dimmed));
			if (section.heading) {
				new Setting(sectionEl).setName(section.heading).setHeading();
			}
			for (const row of section.rows) {
				const setting = new Setting(sectionEl).setName(row.name);
				if (row.desc) setting.setDesc(row.desc);
				row.build(setting);
			}
		}
	}

	/**
	 * Redraws through whichever path this Obsidian actually renders with.
	 * update() re-runs getSettingDefinitions and repaints, and exists only from
	 * 1.13; before that the tab is rebuilt imperatively.
	 */
	private redraw(): void {
		// update() arrived in 1.13 alongside the declarative API, and this
		// plugin still supports 1.7.2, so it is reached only when the running
		// version actually has it. Older versions rebuild imperatively.
		const update: unknown = Reflect.get(this, 'update');
		if (typeof update === 'function') (update as () => void).call(this);
		else this.renderImperative();
	}

	/** State both paths reset before they lay the tab out again. */
	private beginRender(): void {
		this.saveButton = null;
		this.actionButtons = {};
		this.draft = this.saving ? this.draft : this.draftFromSettings();
	}

	/**
	 * Repaints the working button where it stands. Driven by the plugin's
	 * progress tick while a count is live, and by the tab's own timer for the
	 * stretches when there is none, so the button never freezes mid-word.
	 */
	paintProgress(): void {
		const progress = this.host.getProgress();
		// Work that started elsewhere is not shown here; a click during it is
		// answered with a notice instead. Disabling for it would need a repaint
		// when it ends, and nothing announces that for a small transfer.
		const disabled = !this.host.hasCredentials() || this.action !== null;

		for (const [key, button] of Object.entries(this.actionButtons)) {
			const action = key as Action;
			const el = button.buttonEl;
			const active = this.action === action;

			button.setDisabled(disabled);

			el.toggleClass('ultisync-working', active);
			if (!active) {
				el.removeClass('ultisync-indeterminate');
				el.style.removeProperty('--ultisync-fill');
				button.setButtonText(ACTION_LABEL[action].idle);
				continue;
			}

			if (progress) {
				const percent = progressPercent(progress);
				el.removeClass('ultisync-indeterminate');
				el.style.setProperty('--ultisync-fill', `${percent}%`);
				button.setButtonText(
					`${PHASE_VERB[progress.phase]} ${progress.done}/${progress.total}`,
				);
			} else {
				el.addClass('ultisync-indeterminate');
				el.style.removeProperty('--ultisync-fill');
				button.setButtonText(`${ACTION_LABEL[action].busy}…`);
			}
		}
	}

	/** Runs one action with its button showing the work, start to finish. */
	private async runAction(action: Action, run: () => Promise<void>): Promise<void> {
		if (this.action !== null || this.host.isBusy()) return;
		this.action = action;
		this.actionTimer = window.setInterval(() => this.paintProgress(), BUTTON_TICK_MS);
		this.paintProgress();
		try {
			await run();
		} finally {
			this.action = null;
			if (this.actionTimer !== null) {
				window.clearInterval(this.actionTimer);
				this.actionTimer = null;
			}
			this.redraw();
		}
	}

	/**
	 * Turns a settings row into a plain full-width block, for the pieces of
	 * this tab that are not a name/description/control triple: the header, the
	 * extension grids and the save row. The name and description stay in the
	 * definition, so the block is still reachable from settings search.
	 */
	private asBlock(setting: Setting): HTMLElement {
		setting.settingEl.empty();
		setting.settingEl.addClass('ultisync-block');
		return setting.settingEl;
	}

	// ---------------------------------------------------------------------
	// Shared layout
	// ---------------------------------------------------------------------

	private sections(): SectionSpec[] {
		// Nothing below the credentials is meaningful until GitHub is reachable,
		// so it stays visibly out of play rather than silently doing nothing.
		const gated = !this.host.hasCredentials();
		const extensionsGated = gated || !this.host.settings.syncEnabled;

		return [
			{ heading: 'GitHub', cls: 'ultisync-box', rows: this.credentialRows() },
			{ heading: 'Synchronization', dimmed: gated, rows: [this.syncToggleRow()] },
			{
				heading: 'Pull extensions',
				dimmed: extensionsGated,
				rows: this.pullExtensionRows(),
			},
			{
				heading: 'Push extensions',
				dimmed: extensionsGated,
				rows: [this.pushExtensionRow()],
			},
			{ heading: 'Ignored paths', dimmed: gated, rows: [this.ignoredPathsRow()] },
			{ heading: 'Danger zone', cls: 'ultisync-danger-zone', rows: this.dangerZoneRows() },
			{ heading: 'Device', rows: this.deviceRows() },
			{ heading: 'Report a bug', rows: this.helpRows() },
		];
	}

	/**
	 * Puts a section in or out of play. The group element is the one `cls`
	 * lands on and the one holding the heading, so the gate goes there rather
	 * than on the row, which keeps the heading in step with its rows.
	 */
	private applyGate(setting: Setting, dimmed: boolean | undefined): void {
		const groupEl = setting.settingEl.closest<HTMLElement>('.setting-group');
		groupEl?.toggleClass('ultisync-dimmed', Boolean(dimmed));
	}

	private renderHeader(containerEl: HTMLElement): void {
		const header = containerEl.createDiv({ cls: 'ultisync-header' });

		const state = this.host.getConnectionState();
		const copy: Record<ConnectionState, { text: string; tone: string }> = {
			healthy: { text: 'Connection healthy', tone: 'green' },
			checking: { text: 'Checking connection…', tone: 'orange' },
			incomplete: { text: 'Complete setup', tone: 'orange' },
			failed: { text: 'Not connected', tone: 'red' },
		};
		const { text, tone } = copy[state];

		const status = header.createDiv({ cls: 'ultisync-conn' });
		status.createSpan({ cls: `ultisync-dot ultisync-dot-${tone}` });
		status.createSpan({ text });

		const reset = header.createEl('button', { cls: 'ultisync-reset' });
		setIcon(reset, 'rotate-ccw');
		reset.setAttribute('aria-label', 'Reset all credentials and plugin settings');
		reset.setAttribute('title', 'Reset all credentials and plugin settings');
		reset.addEventListener('click', () => this.host.confirmReset());
	}

	private renderIntro(containerEl: HTMLElement): void {
		containerEl.createEl('p', {
			text: 'Settings and synchronization state are local to this installation.',
		});

		// Two engines writing the same files will each see the other's writes as
		// someone else's edits, which is exactly how conflicts are manufactured.
		const caution = containerEl.createDiv({ cls: 'ultisync-caution' });
		caution.createEl('strong', { text: 'One sync engine at a time. ' });
		caution.createSpan({
			text: 'If this vault is also synced by Obsidian Sync, iCloud, Dropbox or OneDrive, the two will overwrite each other and produce conflicts. Turn the others off for this vault.',
		});
	}

	// ---------------------------------------------------------------------
	// Credentials
	// ---------------------------------------------------------------------

	private draftFromSettings(): CredentialDraft {
		const { githubOwner, githubRepo, branch, token } = this.host.settings;
		return { githubOwner, githubRepo, branch, token };
	}

	private allFieldsFilled(): boolean {
		return Boolean(this.draft.githubOwner && this.draft.githubRepo && this.draft.token);
	}

	private isDirty(): boolean {
		const saved = this.draftFromSettings();
		return (
			saved.githubOwner !== this.draft.githubOwner ||
			saved.githubRepo !== this.draft.githubRepo ||
			saved.branch !== this.draft.branch ||
			saved.token !== this.draft.token
		);
	}

	/**
	 * Says where the token actually ends up, which differs by Obsidian version.
	 * Somebody deciding how much to trust this field is entitled to know that
	 * without reading the source, and "never logged" on its own reads as a
	 * stronger promise than it is.
	 */
	private tokenStorageNote(): string {
		const scope =
			'Fine-grained token limited to this repository, with Contents read and write and nothing else.';
		const revoke = 'You can revoke it on GitHub at any time.';

		if (usesSecretStorage(this.app)) {
			return `${scope} It is held in Obsidian's secret storage for this vault, not in the plugin's data file. ${revoke}`;
		}

		const path = `${this.app.vault.configDir}/plugins/ultisync/data.json`;
		return (
			`${scope} This version of Obsidian has no secret storage, so it is stored in plain text at ${path}. ` +
			'The plugin never syncs that folder, but anything that copies your whole vault — iCloud, Dropbox, Obsidian Sync, a backup — copies the token with it. ' +
			revoke
		);
	}

	private credentialRows(): RowSpec[] {
		return [
			{
				name: 'GitHub owner',
				desc: 'GitHub account or organization that owns the repository.',
				aliases: ['account', 'organization', 'username'],
				build: (setting) =>
					setting.addText((text) =>
						text
							.setPlaceholder('Your GitHub Username')
							.setValue(this.draft.githubOwner)
							.onChange((value) => {
								this.draft.githubOwner = value.trim();
								this.refreshSaveButton();
							}),
					),
			},
			{
				name: 'GitHub repository',
				desc: 'Repository name without .git.',
				aliases: ['repo'],
				build: (setting) =>
					setting.addText((text) =>
						text
							.setPlaceholder('my-obsidian-vault')
							.setValue(this.draft.githubRepo)
							.onChange((value) => {
								this.draft.githubRepo = value.trim();
								this.refreshSaveButton();
							}),
					),
			},
			{
				name: 'Branch',
				desc: 'The single synchronization branch. Defaults to main.',
				build: (setting) =>
					setting.addText((text) =>
						text.setValue(this.draft.branch).onChange((value) => {
							this.draft.branch = value.trim() || 'main';
							this.refreshSaveButton();
						}),
					),
			},
			{
				name: 'Personal access token',
				desc: this.tokenStorageNote(),
				aliases: ['pat', 'credentials', 'password'],
				build: (setting) => {
					setting.addText((text) => {
						text.inputEl.type = 'password';
						text
							.setPlaceholder('github_pat_...')
							.setValue(this.draft.token)
							.onChange((value) => {
								this.draft.token = value.trim();
								this.refreshSaveButton();
							});
					});
					this.renderTokenHelp(setting.descEl);
				},
			},
			{
				name: 'Save credentials',
				desc: 'Stores the details above and checks the repository is reachable.',
				build: (setting) => {
					const saveRow = this.asBlock(setting).createDiv({ cls: 'ultisync-save-row' });
					this.saveButton = new ButtonComponent(saveRow).onClick(async () => {
						if (this.saving || !this.allFieldsFilled()) return;
						this.saving = true;
						this.refreshSaveButton();
						try {
							await this.host.applyCredentials({ ...this.draft });
						} finally {
							this.saving = false;
							this.redraw();
						}
					});
					// One place decides the label, the enabled state and the accent,
					// so the button cannot drift out of step with the fields.
					this.refreshSaveButton();
				},
			},
		];
	}

	/**
	 * Updates only the Save button. A full redraw would rebuild the inputs and
	 * steal focus on every keystroke.
	 */
	private refreshSaveButton(): void {
		const button = this.saveButton;
		if (!button) return;

		const filled = this.allFieldsFilled();
		const settled = filled && !this.isDirty() && this.host.hasCredentials();
		const active = !this.saving && filled && !settled;

		button.setButtonText(this.saving ? 'Checking…' : settled ? 'Saved' : 'Save');
		button.setDisabled(!active);
		if (active) button.setCta();
		else button.removeCta();
	}

	private renderTokenHelp(containerEl: HTMLElement): void {
		const details = containerEl.createEl('details', { cls: 'ultisync-help' });
		details.createEl('summary', { text: 'How to get the PAT' });

		const list = details.createEl('ol');
		for (const step of PAT_STEPS) {
			list.createEl('li', { text: step });
		}

		details.createEl('p', {
			cls: 'setting-item-description',
			text: usesSecretStorage(this.app)
				? 'Uninstalling the plugin clears the token from Obsidian\'s secret storage the next time UltiSync is installed in this vault. Reset (the arrow at the top) clears it immediately.'
				: 'Anyone with access to the vault folder can read the token, so scope it to the one repository. Uninstalling the plugin deletes its data file, token included.',
		});
	}

	// ---------------------------------------------------------------------
	// Synchronization
	// ---------------------------------------------------------------------

	private syncToggleRow(): RowSpec {
		return {
			name: 'Sync',
			aliases: ['enable', 'automatic', 'push delay'],
			build: (setting) => {
				setting.addToggle((toggle) =>
					toggle.setValue(this.host.settings.syncEnabled).onChange(async (value) => {
						await this.host.setSyncEnabled(value);
						this.redraw();
					}),
				);

				const details = setting.descEl.createEl('details', { cls: 'ultisync-help' });
				details.createEl('summary', { text: 'How syncing works' });
				details.createEl('p', {
					text: `A push goes out ${PUSH_DELAY_SECONDS} seconds after your last edit, and the timer restarts on every further edit.`,
				});
				details.createEl('p', {
					text: 'GitHub is checked every five seconds while Obsidian is open and visible, and again as soon as it comes back to the foreground. Nothing is checked while the window is hidden.',
				});
			},
		};
	}

	// ---------------------------------------------------------------------
	// Extensions
	// ---------------------------------------------------------------------

	private pullExtensionRows(): RowSpec[] {
		return [
			{
				name: 'Repository size',
				desc:
					'Git keeps every version of every file forever. Text is cheap; images, audio and video are not, and cannot be removed later without rewriting history. GitHub blocks any single file over 100 MB and recommends keeping repositories under 1 GB.',
				build: (setting) => setting.setClass('ultisync-extensions-note'),
			},
			{
				name: 'Pull extensions',
				desc: this.host.settings.pullExtensions.length
					? 'Selected extensions will be downloaded from GitHub.'
					: 'No extensions selected. Nothing will be downloaded until you choose at least one.',
				aliases: ['download', 'file types'],
				build: (setting) =>
					this.renderExtensionSelector(
						this.asBlock(setting),
						this.host.settings.pullExtensions,
						async (value) => {
							this.host.settings.pullExtensions = value;
							await this.host.saveSettings();
						},
					),
			},
		];
	}

	private pushExtensionRow(): RowSpec {
		return {
			name: 'Push extensions',
			desc: this.host.settings.pushExtensions.length
				? 'Selected extensions may be pushed to GitHub.'
				: 'No extensions selected. Nothing will be pushed automatically.',
			aliases: ['upload', 'file types'],
			build: (setting) =>
				this.renderExtensionSelector(
					this.asBlock(setting),
					this.host.settings.pushExtensions,
					async (value) => {
						this.host.settings.pushExtensions = value;
						await this.host.saveSettings();
					},
				),
		};
	}

	private renderExtensionSelector(
		containerEl: HTMLElement,
		selected: string[],
		onChange: (value: string[]) => Promise<void>,
	): void {
		const normalizedSelected = selected.map(normalizeExtension);

		const controls = containerEl.createDiv('ultisync-extension-controls');
		controls.createEl('button', { text: 'Select all' }).addEventListener('click', () => {
			void onChange([...SUPPORTED_EXTENSIONS]);
			this.redraw();
		});
		controls.createEl('button', { text: 'Clear all' }).addEventListener('click', () => {
			void onChange([]);
			this.redraw();
		});

		const grid = containerEl.createDiv('ultisync-extension-grid');
		for (const extension of SUPPORTED_EXTENSIONS) {
			const label = grid.createEl('label');
			const input = label.createEl('input', { type: 'checkbox' });
			input.checked = normalizedSelected.includes(extension);
			label.createSpan({ text: extension });

			input.addEventListener('change', () => {
				const next = new Set(normalizedSelected);
				if (input.checked) next.add(extension);
				else next.delete(extension);
				void onChange([...next]);
			});
		}
	}

	// ---------------------------------------------------------------------
	// Ignored paths
	// ---------------------------------------------------------------------

	private ignoredPathsRow(): RowSpec {
		// The configuration folder is whatever this vault calls it, so the
		// example has to be read off the vault rather than assumed.
		const configDir = this.app.vault.configDir;
		const example = `${configDir}/workspace.json`;

		return {
			name: 'Ignored paths',
			desc: `One path or path prefix per line. Example: ${example}`,
			aliases: ['exclude', 'skip'],
			build: (setting) =>
				setting.addTextArea((text) =>
					text
						.setPlaceholder(`${example}\n${configDir}/workspace-mobile.json`)
						.setValue(this.host.settings.ignoredPaths.join('\n'))
						.onChange(async (value) => {
							this.host.settings.ignoredPaths = value
								.split(/\r?\n/)
								.map(normalizePath)
								.map((path) => path.trim())
								.filter(Boolean);
							await this.host.saveSettings();
						}),
				),
		};
	}

	// ---------------------------------------------------------------------
	// Danger zone
	// ---------------------------------------------------------------------

	private dangerZoneRows(): RowSpec[] {
		return [
			{
				name: 'Push',
				desc: this.pushDescription(),
				aliases: ['upload', 'send'],
				build: (setting) =>
					setting.addButton((button) => {
						this.actionButtons.push = button;
						button
							.setWarning()
							.setButtonText(ACTION_LABEL.push.idle)
							.onClick(() => {
								void this.runAction('push', () => this.host.pushNow());
							});
						button.buttonEl.addClass('ultisync-action');
						this.paintProgress();
					}),
			},
			{
				name: 'Reset and re-pull from GitHub',
				desc: this.resetDescription(),
				aliases: ['start over', 'redownload'],
				build: (setting) =>
					setting.addButton((button) => {
						this.actionButtons.reset = button;
						button
							.setWarning()
							.setButtonText(ACTION_LABEL.reset.idle)
							.onClick(() => {
								void this.runAction('reset', () => this.host.resetSyncState());
							});
						button.buttonEl.addClass('ultisync-action');
						this.paintProgress();
					}),
			},
		];
	}

	private pushDescription(): string {
		const always =
			'Sends this vault to GitHub now: new files, edits, renames and deletions. Only files matching Push extensions are sent, ignored paths are skipped, and a large batch of deletions is confirmed first. Works with Sync on or off.';
		return this.host.settings.syncEnabled
			? `${always} With Sync on this is rarely needed: edits go out by themselves a few seconds after you stop typing.`
			: `${always} If this vault has never been linked, it is compared with GitHub first and you choose the starting point.`;
	}

	private resetDescription(): string {
		return (
			"Removes this vault's synced files, then downloads them again from GitHub. " +
			"They are trashed according to Obsidian's own setting for deleted files, under Files and links. " +
			'A local change that was never pushed does not come back. ' +
			'Affects only files matching your Pull or Push extensions; ignored paths are left alone. GitHub is not modified.'
		);
	}

	// ---------------------------------------------------------------------
	// Device
	// ---------------------------------------------------------------------

	private deviceRows(): RowSpec[] {
		const status = this.host.getStatus();

		return [
			{
				name: 'Device ID',
				desc: 'Generated locally and never derived from hardware identifiers.',
				build: (setting) =>
					setting.addText((text) => text.setValue(this.host.getDeviceId()).setDisabled(true)),
			},
			{
				name: 'Current status',
				desc: status.detail ?? status.status,
				build: () => undefined,
			},
		];
	}

	// ---------------------------------------------------------------------
	// Report a bug
	// ---------------------------------------------------------------------

	private helpRows(): RowSpec[] {
		return [
			{
				// Unnamed on purpose: the heading above already says it, and
				// saying it twice in two lines reads as two separate things.
				name: '',
				desc: 'Open a new issue on GitHub with the versions and platform already filled in. Posting needs a free GitHub account.',
				aliases: ['bug', 'issue', 'github', 'support', 'help', 'feedback'],
				build: (setting) =>
					setting.addButton((button) =>
						button
							.setIcon(BUG_ICON)
							.setTooltip('Report a bug')
							.onClick(() => {
								window.open(this.bugReportUrl(), '_blank');
							}),
					),
			},
		];
	}

	/**
	 * Fills in what a report is not much use without. Everything here is
	 * already on screen elsewhere in this tab; prefilling it only saves the
	 * exchange where it has to be asked for.
	 */
	private bugReportUrl(): string {
		const body = [
			'What happened:',
			'',
			'What you expected instead:',
			'',
			'Steps to reproduce:',
			'',
			'---',
			`UltiSync ${this.version}`,
			`Obsidian ${apiVersion}`,
			`Platform: ${devicePlatform()}`,
		].join('\n');

		return `${REPO_URL}/issues/new?labels=bug&body=${encodeURIComponent(body)}`;
	}
}
