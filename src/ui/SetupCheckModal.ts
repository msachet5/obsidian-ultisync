import { App, Modal, Setting } from 'obsidian';
import { SetupCheckResult } from '../sync/SetupCheck';
import {
	ExtrasPolicy,
	SetupDecision,
	Winner,
	isDecided,
	isDestructive,
	planFor,
} from '../sync/SetupPlan';
import { ConfirmModal } from './ConfirmModal';

/** The answer the modal reports: a decision to carry out, or nothing. */
export type SetupOutcome = SetupDecision | 'cancel';

export interface SetupModalOptions {
	/** What the primary button says. "Start syncing" when the switch is
	 *  about to go on; "Push" when a push is what asked for the check. */
	primaryLabel: string;
	/** Shown under the buttons, explaining what cancelling leaves behind. */
	cancelNote: string;
}

function count(n: number, noun = 'file'): string {
	return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Puts the comparison to the user and collects one decision.
 *
 * Three situations need no choice at all and get a single button: nothing
 * differs, GitHub is empty, or one side simply has more. Everything else is
 * built from two questions asked only when they apply — which version wins
 * for a file that differs in both places, and whether files only one side has
 * are kept or dropped — so a vault that only needs one answer is never asked
 * two. A choice that loses files is confirmed here, with the list, before the
 * modal reports it.
 */
export class SetupCheckModal extends Modal {
	private resolved = false;
	private winner: Winner | null = null;
	private extras: ExtrasPolicy = 'keep';
	private primaryButton: HTMLButtonElement | null = null;

	constructor(
		app: App,
		private result: SetupCheckResult,
		private options: SetupModalOptions,
		private onDecision: (outcome: SetupOutcome) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, result } = this;
		contentEl.empty();
		this.modalEl.addClass('ultisync-setup-modal');

		this.titleEl.setText(this.title());
		contentEl.createEl('p', { text: this.summary() });

		if (result.conflicting.length) this.renderWinnerChoice();
		if (this.hasExtras() && result.relation !== 'remote-empty') this.renderExtrasChoice();

		this.renderFileLists();

		const buttons = new Setting(contentEl);
		buttons.addButton((button) => {
			this.primaryButton = button.buttonEl;
			button.setButtonText(this.options.primaryLabel).onClick(() => this.submit());
		});
		buttons.addButton((button) =>
			button.setButtonText('Cancel').onClick(() => this.decide('cancel')),
		);
		this.refreshPrimary();

		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: this.options.cancelNote,
		});
	}

	private hasExtras(): boolean {
		return this.result.localOnly.length > 0 || this.result.remoteOnly.length > 0;
	}

	private title(): string {
		switch (this.result.relation) {
			case 'up-to-date':
				return 'This vault is up to date';
			case 'remote-empty':
				return 'The repository is empty';
			case 'remote-ahead':
				return 'GitHub has files this vault does not';
			case 'local-ahead':
				return 'This vault has files GitHub does not';
			case 'both-ahead':
				return 'Both sides have files the other does not';
			case 'diverged':
				return 'Some files differ on both sides';
		}
	}

	private summary(): string {
		const { relation, localOnly, remoteOnly, conflicting } = this.result;
		switch (relation) {
			case 'up-to-date':
				return 'Everything here already matches GitHub. Nothing will be moved.';
			case 'remote-empty':
				return `Nothing is on GitHub yet, so this vault's ${count(localOnly.length)} will be uploaded as the starting point.`;
			case 'remote-ahead':
				return `GitHub has ${count(remoteOnly.length)} this vault does not, and nothing here conflicts with them.`;
			case 'local-ahead':
				return `This vault has ${count(localOnly.length)} GitHub does not, and nothing on GitHub conflicts with them.`;
			case 'both-ahead':
				return `This vault has ${count(localOnly.length)} GitHub does not, and GitHub has ${count(remoteOnly.length)} this vault does not. No file differs on both sides.`;
			case 'diverged':
				return `${count(conflicting.length)} exist in both places with different contents. There is no shared history to merge them from, so one side has to win for those files. The versions that lose are moved to the vault's trash, or replaced on GitHub.`;
		}
	}

	/** Which side wins for the files that differ. Mandatory when it applies. */
	private renderWinnerChoice(): void {
		const n = this.result.conflicting.length;
		const group = this.contentEl.createDiv({ cls: 'ultisync-choice' });
		group.createDiv({
			cls: 'ultisync-choice-title',
			text: `Which version wins for the ${count(n, 'differing file')}?`,
		});
		this.radio(group, 'winner', 'local', 'This vault', `GitHub's ${count(n)} are replaced with the versions here.`);
		this.radio(group, 'winner', 'remote', 'GitHub', `The ${count(n)} here are trashed and downloaded again from GitHub.`);
	}

	/** What happens to files only one side has. Defaults to keeping them. */
	private renderExtrasChoice(): void {
		const { localOnly, remoteOnly } = this.result;
		const group = this.contentEl.createDiv({ cls: 'ultisync-choice' });
		group.createDiv({ cls: 'ultisync-choice-title', text: 'Files only one side has' });

		const both: string[] = [];
		if (remoteOnly.length) both.push(`download ${count(remoteOnly.length)} from GitHub`);
		if (localOnly.length) both.push(`upload ${count(localOnly.length)} from this vault`);
		this.radio(group, 'extras', 'keep', 'Keep both', `${both.join(' and ')}. Nothing is lost.`, true);

		if (remoteOnly.length) {
			this.radio(
				group,
				'extras',
				'local-only',
				'Use only this vault',
				`Delete the ${count(remoteOnly.length)} that only GitHub has from GitHub.`,
			);
		}
		if (localOnly.length) {
			this.radio(
				group,
				'extras',
				'remote-only',
				'Use only GitHub',
				`Move the ${count(localOnly.length)} that only this vault has to the trash.`,
			);
		}
	}

	private radio(
		parent: HTMLElement,
		name: 'winner' | 'extras',
		value: Winner | ExtrasPolicy,
		label: string,
		hint: string,
		checked = false,
	): void {
		const row = parent.createEl('label', { cls: 'ultisync-radio' });
		const input = row.createEl('input', { type: 'radio' });
		input.name = `ultisync-${name}`;
		input.value = value;
		input.checked = checked;
		const text = row.createDiv({ cls: 'ultisync-radio-text' });
		text.createDiv({ cls: 'ultisync-radio-label', text: label });
		text.createDiv({ cls: 'ultisync-radio-hint', text: hint });

		input.addEventListener('change', () => {
			if (!input.checked) return;
			if (name === 'winner') this.winner = value as Winner;
			else this.extras = value as ExtrasPolicy;
			this.refreshPrimary();
		});
	}

	private decision(): SetupDecision {
		return { winner: this.winner, extras: this.extras };
	}

	/**
	 * The primary button reads as the choice it will carry out: disabled until
	 * the mandatory question is answered, warning-coloured once the answer
	 * loses something.
	 */
	private refreshPrimary(): void {
		const button = this.primaryButton;
		if (!button) return;
		const decision = this.decision();
		const ready = isDecided(this.result, decision);
		button.disabled = !ready;
		const destructive = ready && isDestructive(planFor(this.result, decision));
		button.toggleClass('mod-warning', destructive);
		button.toggleClass('mod-cta', !destructive);
	}

	private submit(): void {
		const decision = this.decision();
		if (!isDecided(this.result, decision)) return;
		const plan = planFor(this.result, decision);
		if (!isDestructive(plan)) {
			this.decide(decision);
			return;
		}

		// Everything the choice loses, in one list, before anything moves.
		const body: string[] = [];
		const list: string[] = [];
		if (plan.deleteRemote.length) {
			body.push(`${count(plan.deleteRemote.length)} will be deleted from GitHub.`);
			list.push(...plan.deleteRemote.map((path) => `GitHub: ${path}`));
		}
		if (plan.trashLocal.length) {
			body.push(`${count(plan.trashLocal.length)} in this vault will be moved to the trash.`);
			list.push(...plan.trashLocal.map((path) => `Vault: ${path}`));
		}
		if (plan.overwriteLocal.length) {
			body.push(
				`${count(plan.overwriteLocal.length)} in this vault will be replaced with GitHub's version. The current copies are trashed first.`,
			);
			list.push(...plan.overwriteLocal.map((path) => `Replace: ${path}`));
		}
		body.push(
			"Trashed files follow Obsidian's own setting for deleted files under Files and links. A file deleted from GitHub stays in the repository's history.",
		);

		new ConfirmModal(
			this.app,
			{ title: 'Confirm what will be lost', body, list, confirmLabel: 'Proceed' },
			(confirmed) => {
				if (confirmed) this.decide(decision);
			},
		).open();
	}

	/** Shows what is actually different, capped so a big difference stays readable. */
	private renderFileLists(): void {
		const groups: [string, string[]][] = [
			['Differ on both sides', this.result.conflicting],
			['Only on GitHub', this.result.remoteOnly],
			['Only in this vault', this.result.localOnly],
		];

		for (const [label, paths] of groups) {
			if (!paths.length) continue;
			const details = this.contentEl.createEl('details', { cls: 'ultisync-file-list' });
			details.createEl('summary', { text: `${label} (${paths.length})` });
			const list = details.createEl('ul');
			for (const path of paths.slice(0, 50)) {
				list.createEl('li', { text: path });
			}
			if (paths.length > 50) {
				list.createEl('li', { text: `...and ${paths.length - 50} more` });
			}
		}
	}

	private decide(outcome: SetupOutcome): void {
		if (this.resolved) return;
		this.resolved = true;
		this.close();
		this.onDecision(outcome);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) {
			this.resolved = true;
			this.onDecision('cancel');
		}
	}
}
