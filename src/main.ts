import { Notice, Plugin, TAbstractFile, TFile } from 'obsidian';
import { SyncManager } from './sync/SyncManager';
import { SCHEMA_VERSION, migrate } from './sync/Migrations';
import { SyncStateStore, generateDeviceId } from './sync/SyncState';
import { ConflictModal } from './ui/ConflictModal';
import { ConfirmModal, confirmWithModal } from './ui/ConfirmModal';
import { CredentialDraft, SettingsTab } from './ui/SettingsTab';
import { SetupCheckModal, SetupModalOptions, SetupOutcome } from './ui/SetupCheckModal';
import { planFor } from './sync/SetupPlan';
import { StatusBarController } from './ui/StatusBar';
import { ULTISYNC_ICON, registerIcons } from './ui/icons';
import { SYNC_PANEL_VIEW_TYPE, SyncPanelView } from './ui/SyncPanelView';
import { SetupCheckResult, summarize } from './sync/SetupCheck';
import { GitHubApiError } from './github/GitHubClient';
import {
	ConnectionState,
	DEFAULT_EXTENSIONS,
	DEFAULT_SETTINGS,
	DEFAULT_STATE,
	LARGE_CHECK_BYTES,
	UltiSyncSettings,
	PersistedData,
	PROGRESS_TICK_MS,
	SyncStateData,
	SyncStatus,
} from './types';
import { loadToken, settingsForDisk } from './TokenStore';
import {
	isIgnoredPath,
	matchesExtensions,
	normalizePath,
	setConfigDir,
} from './vault/PathFilter';

/**
 * Obsidian does not type the settings modal, so opening this plugin's own tab
 * goes through a narrow cast rather than an app-wide `any`.
 */
/**
 * Turns a failure into something a person can act on. The distinction that
 * matters is whose problem it is: the network, the token, or the repository.
 */
function describeConnectionFailure(error: unknown): string {
	if (error instanceof GitHubApiError) {
		switch (error.status) {
			case 0:
				return 'Not connected. Check your internet connection and try again.';
			case 401:
				return 'Bad credentials, please recheck your GitHub creds. The token may have expired or been revoked — generate a new one if so.';
			case 403:
				return 'GitHub refused the request. The token may lack Contents read/write on this repository, or the rate limit is exhausted.';
			case 404:
				return 'Repository or branch not found. Check the owner and repository names, and that the token can see this repository.';
			default:
				return `GitHub request failed (HTTP ${error.status}): ${error.message}`;
		}
	}
	return error instanceof Error ? error.message : 'Connection failed.';
}

/** A defaults object nobody else shares, so later edits cannot reach back. */
function freshSettings(): UltiSyncSettings {
	return {
		...DEFAULT_SETTINGS,
		pullExtensions: [...DEFAULT_EXTENSIONS],
		pushExtensions: [...DEFAULT_EXTENSIONS],
		ignoredPaths: [],
	};
}

function formatBytes(bytes: number): string {
	const mb = bytes / (1024 * 1024);
	return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

interface SettingsCapableApp {
	setting?: {
		open(): void;
		openTabById(id: string): void;
	};
}

export default class UltiSyncPlugin extends Plugin {
	settings: UltiSyncSettings = freshSettings();

	private state!: SyncStateData;
	private stateStore!: SyncStateStore;
	private syncManager!: SyncManager;
	private statusBar!: StatusBarController;
	private settingsTab!: SettingsTab;

	private currentStatus: SyncStatus = 'synced';
	private currentStatusDetail = 'Ready';

	// Set while a comparison is running, so a second Save or toggle cannot start
	// an overlapping check against the same repository.
	private checkRunning = false;

	private connectionState: ConnectionState = 'incomplete';

	// Whether the last paint drew a bar or a ring, so the idle ticks can stop
	// early but the one tick that clears them still lands.
	private progressPainted = false;

	// Set while the plugin itself is moving files in bulk, so the vault events
	// that produces are not mistaken for the user's edits. A reset trashing a
	// vault used to arm a push that would have deleted those files from
	// GitHub before the re-pull had brought them back.
	private vaultEventsMuted = false;

	async onload(): Promise<void> {
		// Before anything asks for one by name.
		registerIcons();
		setConfigDir(this.app.vault.configDir);
		await this.loadSettingsAndState();

		this.statusBar = new StatusBarController(
			this,
			this.app.workspace,
			() => this.openStatus(),
			() => this.refreshDerivedStatus(),
		);
		this.syncManager = this.createSyncManager();

		this.settingsTab = new SettingsTab(
				this.app,
				{
					settings: this.settings,
					saveSettings: () => this.saveSettings(),
					applyCredentials: (draft) => this.applyCredentials(draft),
				setSyncEnabled: (enabled) => this.setSyncEnabled(enabled),
				hasCredentials: () => this.hasCredentials(),
				getConnectionState: () => this.getConnectionState(),
				confirmReset: () => this.confirmReset(),
				pushNow: () => this.pushFromSettings(),
				resetSyncState: () => this.resetSyncState(),
				getDeviceId: () => this.state.deviceId,
				getStatus: () => this.statusSnapshot(),
				getProgress: () => this.syncManager.getProgress(),
				isBusy: () => this.checkRunning || this.syncManager.isRunning(),
				},
			this,
		);
		this.addSettingTab(this.settingsTab);

		this.registerView(
			SYNC_PANEL_VIEW_TYPE,
			(leaf) =>
				new SyncPanelView(leaf, {
					getStatus: () => this.statusSnapshot(),
					getState: () => this.state,
					getActivity: () => this.syncManager.getActivity(),
					getProgress: () => this.syncManager.getProgress(),
					getPushCountdown: () => this.syncManager.getPushCountdown(),
					openConflicts: () => new ConflictModal(this.app, this.syncManager).open(),
					openSettings: () => this.openSettings(),
				}),
		);

		this.addRibbonIcon(ULTISYNC_ICON, 'UltiSync status', () => {
			void this.revealPanel();
		});

		// The countdown has to drain on its own clock: nothing fires per frame to
		// announce that time has passed. The paint is a no-op once both are idle,
		// so the interval costs nothing while the plugin is at rest.
		this.registerInterval(window.setInterval(() => this.paintProgress(), PROGRESS_TICK_MS));

		this.registerCommands();
		this.registerVaultEvents();
		this.registerActivationEvents();
		this.syncManager.startPolling();

		this.app.workspace.onLayoutReady(() => {
			// A short delay so the vault index is populated before the first scan.
			window.setTimeout(() => {
				void this.probeConnection();
				void this.syncManager.onActivation();
			}, 1500);
		});

		this.refreshDerivedStatus();
	}

	onunload(): void {
		this.syncManager?.destroy();
	}

	private createSyncManager(): SyncManager {
		return new SyncManager(
			this.app,
			this.settings,
			this.stateStore,
			this.state,
			(status, detail) => this.setStatus(status, detail),
			() => this.updateStateReference(),
			() => this.paintProgress(),
			(message) => {
				void this.handleUnrecoverableError(message);
			},
		);
	}

	/**
	 * Nothing will work again until a person changes something, so
	 * synchronization stops instead of retrying every five seconds, and the
	 * switch and the indicator both say why.
	 */
	private async handleUnrecoverableError(message: string): Promise<void> {
		if (!this.settings.syncEnabled) return;
		this.settings.syncEnabled = false;
		await this.persistEverything();
		this.connectionState = 'failed';
		this.refreshSettingsTab();
		this.setStatus('error', message);
	}

	private statusSnapshot(): { status: SyncStatus; detail?: string } {
		return { status: this.currentStatus, detail: this.currentStatusDetail };
	}

	/** Opens the panel in the right sidebar, or reveals it if already there. */
	private async revealPanel(): Promise<void> {
		const [existing] = this.app.workspace.getLeavesOfType(SYNC_PANEL_VIEW_TYPE);
		if (existing) {
			await this.app.workspace.revealLeaf(existing);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
		if (!leaf) {
			new Notice('UltiSync: could not open the status panel.');
			return;
		}

		await leaf.setViewState({ type: SYNC_PANEL_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	/**
	 * Repaints the progress bar and the push countdown where they stand, rather
	 * than redrawing anything. Called several times a second while either is
	 * live, and short-circuited when neither is.
	 */
	private paintProgress(): void {
		const progress = this.syncManager.getProgress();
		const countdown = this.syncManager.getPushCountdown();

		const active = progress !== null || countdown !== null;
		if (!active && !this.progressPainted) return;
		this.progressPainted = active;

		this.statusBar.setProgress(progress, countdown);
		this.settingsTab?.paintProgress();
		for (const leaf of this.app.workspace.getLeavesOfType(SYNC_PANEL_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof SyncPanelView) view.paintProgress();
		}
	}

	// Every status change and every state refresh redraws the panel. It is the
	// only view that has to keep up with a background process.
	private refreshPanel(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(SYNC_PANEL_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof SyncPanelView) view.render();
		}
	}

	hasCredentials(): boolean {
		const { githubOwner, githubRepo, token } = this.settings;
		return Boolean(githubOwner && githubRepo && token);
	}

	getConnectionState(): ConnectionState {
		return this.connectionState;
	}

	private setConnectionState(state: ConnectionState): void {
		const changed = this.connectionState !== state;
		this.connectionState = state;
		this.refreshSettingsTab();
		// "Checking" is transient and says nothing useful in the status bar.
		if (changed && state !== 'checking') this.refreshDerivedStatus();
	}

	/** The settings tab redraws itself when the connection verdict changes. */
	private refreshSettingsTab(): void {
		this.settingsTab?.refresh();
	}

	/**
	 * One question answered in one request: can we reach this repository right
	 * now. Network, credentials and repository all fail into the same place, so
	 * they are reported together rather than as separate concepts.
	 *
	 * A repository with no commits has no branch to read, which is a success:
	 * there is simply nothing there yet.
	 */
	private async probeConnection(
		credentials: CredentialDraft = this.settings,
	): Promise<{ ok: boolean; message?: string }> {
		if (!credentials.githubOwner || !credentials.githubRepo || !credentials.token) {
			this.setConnectionState('incomplete');
			return { ok: false, message: 'Owner, repository and token are all required.' };
		}

		this.setConnectionState('checking');
		const { GitHubClient } = await import('./github/GitHubClient');
		const client = new GitHubClient(
			credentials.githubOwner.trim(),
			credentials.githubRepo.trim(),
			credentials.token,
			credentials.branch.trim() || 'main',
		);

		try {
			await client.getBranchReferenceOrNull(true);
			this.setConnectionState('healthy');
			return { ok: true };
		} catch (error) {
			console.error('[UltiSync]', error);
			this.setConnectionState('failed');
			return { ok: false, message: describeConnectionFailure(error) };
		}
	}

	/**
	 * Save. The credentials are always stored, because losing what someone
	 * typed is worse than storing something that does not work yet. What a
	 * failed check withholds is automatic synchronization, not the settings.
	 */
	private async applyCredentials(draft: CredentialDraft): Promise<void> {
		// A different repository or branch makes every record this vault holds
		// about "the remote" a record about somewhere else. Applied against
		// the new place it would read as mass deletions in both directions.
		const target = (c: CredentialDraft): string =>
			`${c.githubOwner.trim()}/${c.githubRepo.trim()}#${c.branch.trim() || 'main'}`;
		const movedRepository = target(this.settings) !== target(draft);

		Object.assign(this.settings, draft);
		if (movedRepository && this.state.lastSyncedCommit) {
			this.syncManager.destroy();
			this.state = { ...DEFAULT_STATE, deviceId: this.state.deviceId };
			this.restartSyncManager();
			this.state.debugLog.push(
				`${new Date().toISOString()} repository changed to ${target(draft)}; sync state cleared`,
			);
		}
		await this.persistEverything();

		const probe = await this.probeConnection(draft);
		if (!probe.ok) {
			new Notice(`UltiSync: ${probe.message}`, 12000);
			await this.disableSync();
			return;
		}

		// Only the token changed on a vault that is already linked: there is
		// nothing to compare, and the comparison would only offer to redo what
		// is already done.
		if (!this.syncManager.needsStartingPoint()) {
			this.settings.syncEnabled = true;
			await this.persistEverything();
			this.refreshDerivedStatus();
			this.refreshSettingsTab();
			return;
		}

		await this.runSetupCheck({ enableSync: true });
	}

	private async setSyncEnabled(enabled: boolean): Promise<void> {
		if (!enabled) {
			await this.disableSync();
			return;
		}

		// Turning it on is a promise that it will work, so prove it first.
		const probe = await this.probeConnection();
		if (!probe.ok) {
			new Notice(`UltiSync: ${probe.message}`, 12000);
			this.settings.syncEnabled = false;
			await this.persistEverything();
			this.setStatus('error', probe.message ?? 'Not connected.');
			return;
		}

		this.settings.syncEnabled = true;
		await this.persistEverything();

		if (this.syncManager.needsStartingPoint()) {
			await this.runSetupCheck({ enableSync: true });
			return;
		}
		// Already linked, so switching on simply resumes.
		this.refreshDerivedStatus();
	}

	/**
	 * The Push button. It works whether or not the switch is on: the switch
	 * governs what happens by itself, not what a person may ask for. A vault
	 * that has never been linked is compared first, and the choice made there
	 * is what carries the push out.
	 */
	private async pushFromSettings(): Promise<void> {
		if (!this.hasCredentials()) {
			new Notice('UltiSync: enter the GitHub owner, repository and token first.');
			return;
		}
		if (this.checkRunning || this.syncManager.isRunning()) {
			new Notice('UltiSync: another operation is in progress. Try again when it finishes.');
			return;
		}
		if (this.connectionState !== 'healthy') {
			const probe = await this.probeConnection();
			if (!probe.ok) {
				new Notice(`UltiSync: ${probe.message}`, 12000);
				return;
			}
		}

		if (this.syncManager.needsStartingPoint()) {
			await this.runSetupCheck({ enableSync: false, reason: 'push' });
			return;
		}
		await this.syncManager.pushEverything();
	}

	/** Clears credentials and all synchronization bookkeeping. Files are kept. */
	private async resetEverything(): Promise<void> {
		this.syncManager?.destroy();

		const deviceId = this.state.deviceId;
		// Mutated rather than replaced: the settings tab and the sync manager
		// both hold this object, and swapping it would leave them reading the
		// values that were just cleared.
		Object.assign(this.settings, freshSettings(), { syncEnabled: false });
		this.state = { ...DEFAULT_STATE, deviceId };
		await this.persistEverything();

		this.restartSyncManager();
		this.setConnectionState('incomplete');
		this.refreshDerivedStatus();
		new Notice('UltiSync: credentials and settings cleared. Your files were not touched.');
	}

	/**
	 * Runs the comparison and puts the outcome to the user. Nothing is written
	 * until they answer, and the returned promise settles only once whatever
	 * they chose has been carried out, so a button that started this can show
	 * it working the whole way through.
	 *
	 * With `enableSync` the switch goes on as the decision is accepted, which
	 * is what turning it on or saving credentials means. Without it the vault
	 * is linked and the plan carried out, but nothing automatic starts: that is
	 * what a plain Push on an unlinked vault asks for.
	 */
	private async runSetupCheck(options: {
		enableSync: boolean;
		reason?: 'push';
	}): Promise<void> {
		if (this.checkRunning) return;
		this.checkRunning = true;
		this.setStatus(
			'syncing',
			'Checking vault and repo. Please do not change files while this runs.',
		);

		let result: SetupCheckResult;
		try {
			let warnedLarge = false;
			result = await this.syncManager.runSetupCheck((progress) => {
				if (progress.totalBytes > LARGE_CHECK_BYTES && !warnedLarge) {
					warnedLarge = true;
					new Notice(
						`UltiSync: this vault and repository share ${formatBytes(progress.totalBytes)} of files. ` +
							'The check will take a while. You can leave it running.',
						10000,
					);
				}
				if (progress.total > 0 && progress.done % 25 === 0) {
					this.setStatus(
						'syncing',
						`Checking vault and repo — ${progress.done} of ${progress.total} file(s). Please do not change files while this runs.`,
					);
				}
			});
		} catch (error) {
			const message = describeConnectionFailure(error);
			console.error('[UltiSync]', error);
			new Notice(`UltiSync: ${message}`, 12000);
			// Only GitHub's answer says anything about the connection. A check
			// refused because something else was running says nothing.
			if (error instanceof GitHubApiError) {
				this.setConnectionState('failed');
				this.setStatus('error', message);
				if (options.enableSync) await this.disableSync();
			} else {
				this.refreshDerivedStatus();
			}
			return;
		} finally {
			this.checkRunning = false;
		}

		this.setStatus('pending', `Comparison complete: ${summarize(result)}.`);

		const modal: SetupModalOptions = options.enableSync
			? {
					primaryLabel: 'Start syncing',
					cancelNote:
						'Cancelling leaves synchronization switched off. Turning Sync back on runs this check again.',
				}
			: {
					primaryLabel: 'Push',
					cancelNote:
						'Cancelling changes nothing. Sync stays off either way; this only links the vault and pushes it.',
				};

		const outcome = await new Promise<SetupOutcome>((resolve) => {
			new SetupCheckModal(this.app, result, modal, resolve).open();
		});
		await this.applySetupDecision(result, outcome, options.enableSync);
	}

	private async applySetupDecision(
		result: SetupCheckResult,
		outcome: SetupOutcome,
		enableSync: boolean,
	): Promise<void> {
		if (outcome === 'cancel') {
			if (enableSync) {
				new Notice('UltiSync: left switched off. Turn Sync on to run the check again.');
				await this.disableSync();
			} else {
				new Notice('UltiSync: cancelled. Nothing was changed.');
				this.refreshDerivedStatus();
			}
			return;
		}

		// Accepting an outcome is the moment synchronization starts. Enabled
		// before the transfer so the manager is live for what follows, and
		// persisted so the switch in settings agrees.
		if (enableSync) {
			this.settings.syncEnabled = true;
			await this.persistEverything();
			this.refreshSettingsTab();
		}

		await this.syncManager.adopt(result, planFor(result, outcome));
		this.refreshDerivedStatus();
		this.refreshSettingsTab();

		// Nothing on either side leaves nothing to link to: the repository has
		// no commit until a file is pushed, and there is no file to push.
		if (this.syncManager.needsStartingPoint() && result.relation === 'remote-empty') {
			new Notice(
				'UltiSync: both this vault and the repository are empty, so there is nothing to link yet. Add a note, then press Push or turn Sync off and on.',
				12000,
			);
		}
	}

	private async disableSync(): Promise<void> {
		this.settings.syncEnabled = false;
		await this.persistEverything();
		this.refreshDerivedStatus();
		this.refreshSettingsTab();
	}

	/**
	 * The resting status, worked out from what is actually true rather than
	 * from whatever the last operation happened to leave behind. Called at the
	 * points where nothing is in flight, so it never overwrites "Pulling..."
	 * with a summary of the state it is halfway through changing.
	 */
	private refreshDerivedStatus(): void {
		if (!this.hasCredentials()) {
			this.setStatus('setup', 'Not set up. Open settings to connect a repository.');
			return;
		}
		if (this.connectionState === 'failed') {
			this.setStatus('error', 'Not connected. Check the connection and your token.');
			return;
		}
		if (!this.settings.syncEnabled) {
			this.setStatus(
				'off',
				this.syncManager?.needsStartingPoint()
					? 'Synchronization is off. Not linked to GitHub yet.'
					: 'Synchronization is off. Push and Reset still work from settings.',
			);
			return;
		}
		if (this.syncManager?.needsStartingPoint()) {
			this.setStatus('pending', 'Waiting for a starting point. Turn Sync on to check.');
			return;
		}

		const conflicts = Object.keys(this.state.conflicts).length;
		if (conflicts) {
			this.setStatus('conflict', `${conflicts} conflict(s) need attention.`);
			return;
		}
		this.setStatus('synced', 'Up to date.');
	}

	private confirmReset(): void {
		new ConfirmModal(
			this.app,
			{
				title: 'Reset all credentials and plugin settings?',
				body: 'You will need to re-enter the GitHub owner, repository and personal access token. Your notes are not touched and nothing is deleted from GitHub.',
				confirmLabel: 'Proceed',
			},
			(confirmed) => {
				if (confirmed) void this.resetEverything();
			},
		).open();
	}

	private registerCommands(): void {
		this.addCommand({
			id: 'sync-now',
			name: 'Sync now',
			callback: () => {
				void this.syncManager.syncNow();
			},
		});
		this.addCommand({
			id: 'open-panel',
			name: 'Open status panel',
			callback: () => {
				void this.revealPanel();
			},
		});
		this.addCommand({
			id: 'show-status',
			name: 'Show status',
			callback: () => this.openStatus(),
		});
		this.addCommand({
			id: 'show-conflicts',
			name: 'Show conflicts',
			callback: () => new ConflictModal(this.app, this.syncManager).open(),
		});
		this.addCommand({
			id: 'open-settings',
			name: 'Open settings',
			callback: () => this.openSettings(),
		});
	}

	/** Opens Obsidian's settings modal straight to this plugin's own tab. */
	private openSettings(): void {
		const setting = (this.app as unknown as SettingsCapableApp).setting;
		setting?.open();
		setting?.openTabById(this.manifest.id);
	}

	private registerVaultEvents(): void {
		this.registerEvent(this.app.vault.on('create', (file) => this.handleVaultChange(file)));
		this.registerEvent(this.app.vault.on('modify', (file) => this.handleVaultChange(file)));
		this.registerEvent(this.app.vault.on('delete', (file) => this.handleVaultChange(file)));

		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (this.vaultEventsMuted) return;
				if (
					oldPath &&
					!this.syncManager.isSelfWrite(oldPath) &&
					!isIgnoredPath(file.path, this.settings.ignoredPaths)
				) {
					this.syncManager.markUserNamed(file.path);
					this.syncManager.recordRename(oldPath, file.path);
				}
				this.handleVaultChange(file);
				if (oldPath) {
					this.handleVaultPath(oldPath);
				}
			}),
		);
	}

	private registerActivationEvents(): void {
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.visibilityState === 'visible') {
				void this.syncManager.onActivation();
			}
		});
		this.registerDomEvent(window, 'focus', () => {
			void this.syncManager.onActivation();
		});
	}

	private handleVaultChange(file: TAbstractFile): void {
		this.handleVaultPath(file.path);
	}

	private handleVaultPath(path: string): void {
		if (this.vaultEventsMuted) return;
		if (this.syncManager.isSelfWrite(path)) return;
		if (isIgnoredPath(path, this.settings.ignoredPaths)) return;

		if (matchesExtensions(normalizePath(path), this.settings.pushExtensions)) {
			this.syncManager.markDirty();
		}
	}

	private async loadSettingsAndState(): Promise<void> {
		const raw: unknown = await this.loadData();
		const result = migrate(raw);

		// Prefer Obsidian's secret storage over the data file. A token found in
		// the data file is moved across here; the write below is what removes it.
		const adopted = loadToken(this.app, result.settings.token);
		result.settings.token = adopted.token;

		Object.assign(this.settings, result.settings);
		this.state = result.state;
		this.stateStore = new SyncStateStore(this, () => this.settings);

		if (!this.state.deviceId) {
			this.state.deviceId = generateDeviceId();
		}

		// Written back only when the stored shape actually differed, so an
		// ordinary launch does not rewrite the file for nothing.
		if (result.changed || adopted.migrated) {
			const at = new Date().toISOString();
			for (const note of result.notes) {
				this.state.debugLog.push(`${at} data file upgraded — ${note}`);
			}
			if (adopted.migrated) {
				this.state.debugLog.push(
					`${at} access token moved into Obsidian's secret storage and cleared from the data file`,
				);
			}
			await this.persistEverything();
		}
	}

	async saveSettings(): Promise<void> {
		await this.persistEverything();
		if (this.syncManager) {
			this.syncManager.destroy();
			this.syncManager.startPolling();
		}
	}

	private async persistEverything(): Promise<void> {
		await this.saveData({
			schemaVersion: SCHEMA_VERSION,
			settings: settingsForDisk(this.app, this.settings),
			state: this.state,
		} satisfies PersistedData);
	}

	// Throws away this vault's copy of the synced files and downloads them again.
	// This is the only action in the plugin that destroys local work on purpose,
	// so it is confirmed explicitly and everything it removes is trashed rather
	// than deleted outright.
	async resetSyncState(): Promise<void> {
		const managed = this.managedFiles();

		const confirmed = await confirmWithModal(this.app, {
			title: 'Reset and re-pull from GitHub?',
			body: [
				`${managed.length} file(s) matching your Pull or Push extensions will be removed and downloaded again from GitHub. Ignored paths are left alone.`,
				"The current copies are trashed, following Obsidian's own setting for deleted files under Files and links.",
				'A local change that was never pushed does not come back from GitHub.',
				'GitHub itself is not modified.',
			],
			confirmLabel: 'Reset and re-pull',
		});
		if (!confirmed) {
			new Notice('UltiSync: reset cancelled. Nothing was changed.');
			return;
		}

		if (this.checkRunning || this.syncManager.isRunning()) {
			new Notice('UltiSync: another operation is in progress. Try again when it finishes.');
			return;
		}

		this.syncManager?.destroy();
		this.setStatus('syncing', 'Resetting local files...');

		// Every trashed file fires a delete event. Left audible, those events
		// marked the vault dirty and armed a push that would have carried the
		// deletions to GitHub before the re-pull restored the files.
		this.vaultEventsMuted = true;
		try {
			let done = 0;
			this.syncManager.setProgress({ phase: 'clear', done, total: managed.length });
			for (const file of managed) {
				// Same rule as every other deletion in the plugin: trashFile puts
				// the file wherever the vault's "Deleted files" preference says.
				// Nothing here bypasses that, because a file that was edited
				// locally and never pushed does not come back from GitHub.
				await this.app.fileManager.trashFile(file);
				this.syncManager.setProgress({ phase: 'clear', done: ++done, total: managed.length });
			}
		} catch (error) {
			console.error('[UltiSync]', error);
			new Notice('UltiSync: could not clear local files. Nothing was re-pulled.');
			this.setStatus('error', 'Reset failed while clearing local files.');
			this.restartSyncManager();
			return;
		} finally {
			this.vaultEventsMuted = false;
			this.syncManager.setProgress(null);
		}

		this.state = {
			...DEFAULT_STATE,
			deviceId: this.state.deviceId || generateDeviceId(),
		};
		await this.persistEverything();
		this.restartSyncManager();
		await this.syncManager.initialPull(true);
		this.refreshDerivedStatus();
	}

	/**
	 * Every vault file the plugin is responsible for, in either direction.
	 *
	 * Files it has previously tracked count even when they no longer match the
	 * extension lists. Narrowing the selection used to strand them: no longer
	 * synced, never cleaned up, and invisible to the plugin thereafter.
	 */
	private managedFiles(): TFile[] {
		const extensions = Array.from(
			new Set([...this.settings.pullExtensions, ...this.settings.pushExtensions]),
		);
		const tracked = new Set(Object.keys(this.state.trackedFiles));

		return this.app.vault.getFiles().filter((file) => {
			const path = normalizePath(file.path);
			if (isIgnoredPath(path, this.settings.ignoredPaths)) return false;
			return matchesExtensions(path, extensions) || tracked.has(path);
		});
	}

	private restartSyncManager(): void {
		this.syncManager = this.createSyncManager();
		this.syncManager.startPolling();
	}

	private updateStateReference(): void {
		this.state = this.syncManager.getState();
		this.refreshPanel();
	}

	private setStatus(status: SyncStatus, detail?: string): void {
		const nextDetail = detail ?? status;
		// Every keystroke reports "pending" again. Rebuilding the panel for a
		// status it already shows threw away its scroll position for nothing.
		if (status === this.currentStatus && nextDetail === this.currentStatusDetail) return;
		this.currentStatus = status;
		this.currentStatusDetail = nextDetail;
		this.statusBar?.set(status, detail);
		this.refreshPanel();
	}

	private openStatus(): void {
		const conflicts = Object.keys(this.state.conflicts).length;
		new Notice(
			`UltiSync: ${this.currentStatusDetail}${conflicts ? ` Conflicts: ${conflicts}.` : ''}`,
		);
	}
}
