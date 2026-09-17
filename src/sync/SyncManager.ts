import { App, Notice, Platform, TFile, Vault } from 'obsidian';
import {
	GitHubApiError,
	GitHubClient,
	RemoteSnapshot,
	isRateLimited,
	rateLimitDelayMs,
} from '../github/GitHubClient';
import {
	ACTIVITY_LIMIT,
	ActivityEntry,
	ActivityKind,
	ConflictRecord,
	DEEP_VERIFY_INTERVAL_MS,
	EMPTY_BLOB_SHA,
	UltiSyncSettings,
	LARGE_FILE_WARN_BYTES,
	POLL_HOLD_AFTER_PUSH_MS,
	PROGRESS_MIN_BYTES,
	PROGRESS_MIN_FILES,
	PULL_INTERVAL_MS,
	PUSH_DELAY_SECONDS,
	PushCountdown,
	PushTrigger,
	SELF_WRITE_GRACE_MS,
	SyncPhase,
	SyncProgress,
	SyncStateData,
	SyncStatus,
	VERIFY_INTERVAL_MS,
} from '../types';
import {
	isIgnoredPath,
	isSafeVaultPath,
	isWritableOnThisPlatform,
	matchesExtensions,
	normalizePath,
} from '../vault/PathFilter';
import { base64ToArrayBuffer, gitBlobSha, sha256 } from '../vault/VaultScanner';
import { confirmWithModal } from '../ui/ConfirmModal';
import { ChangeDetector } from './ChangeDetector';
import { ConflictDetector, IdenticalPaths } from './ConflictDetector';
import { attemptMerge } from './MergeAttempt';
import { PullManager } from './PullManager';
import { PushManager, PushOptions } from './PushManager';
import { renamesDeclaredIn } from './RenameRecord';
import { pathsNeverPulled } from './Verify';
import { ProgressCallback, SetupCheck, SetupCheckResult } from './SetupCheck';
import { SetupPlan } from './SetupPlan';
import { SyncStateStore } from './SyncState';

const DEBUG_LOG_LIMIT = 200;

/**
 * How long debug lines are allowed to pile up before they reach the disk.
 * The data file carries the whole tracking table, so writing it per line
 * turned a chatty push into dozens of full rewrites in a row.
 */
const DEBUG_SAVE_DELAY_MS = 750;

/** Ceiling on a rate-limit hold. The hourly budget always resets within this. */
const MAX_RATE_LIMIT_HOLD_MS = 60 * 60 * 1000;

/** Waits between asking GitHub whether it has caught up with our own push. */
const CONFIRM_BACKOFF_MS = [0, 300, 600, 1200, 2400, 4800];

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Path to blob sha for every blob in a snapshot. */
function treeMapOf(remote: RemoteSnapshot): Record<string, string> {
	const map: Record<string, string> = {};
	for (const [path, entry] of remote.entries) {
		if (entry.type === 'blob' && entry.sha) {
			map[path] = entry.sha;
		}
	}
	return map;
}

/**
 * Whether this will still be broken on the next attempt, and every attempt
 * after that, until a person changes something.
 *
 * 401 is a token that expired, was revoked, or was mistyped. 404 is the same
 * class of problem wearing a different number: GitHub answers a repository the
 * token cannot see with "not found" rather than "forbidden", so a fine-grained
 * token whose repository selection changed lands here, as does a mistyped
 * owner or repository name.
 *
 * Everything else is left alone to retry. A 403 may be nothing worse than a
 * rate limit, 409 and 422 are the ordinary branch-moved answers a push already
 * handles, and status 0 is simply no network.
 */
function requiresUserAction(error: unknown): boolean {
	return error instanceof GitHubApiError && (error.status === 401 || error.status === 404);
}

/** A clock time, for telling someone when a wait ends. */
function clockTime(at: number): string {
	const date = new Date(at);
	const pad = (value: number): string => value.toString().padStart(2, '0');
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function megabytes(bytes: number): string {
	return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function basename(path: string): string {
	const cut = path.lastIndexOf('/');
	return cut >= 0 ? path.slice(cut + 1) : path;
}

/** Bullets a path list for a Notice, which renders plain text only. */
function listForPrompt(paths: string[], shown = 12): string {
	const list = paths
		.slice(0, shown)
		.map((path) => `  • ${path}`)
		.join('\n');
	return paths.length > shown ? `${list}\n  ...and ${paths.length - shown} more` : list;
}

export class SyncManager {
	private running = false;
	private requested = false;
	private dirty = false;
	private pushTimer: number | null = null;
	private pollTimer: number | null = null;

	// Nothing automatic (no poll, no debounced push, no follow-up requested
	// mid-push) runs before this moment. It is re-armed when a push finishes, so
	// the next attempt never lands on a branch read GitHub has not caught up
	// with yet: that read is what turned an edit made during a push into a
	// spurious conflict.
	private syncHoldUntil = 0;

	/** Paths this plugin has just written, against the moment the flag lapses. */
	private selfWrites = new Map<string, number>();

	// Paths the user renamed before they were ever pushed. Held in memory only,
	// because it matters for the minute between creating a note and pushing it.
	private userNamed = new Set<string>();

	private activity: ActivityEntry[] = [];

	// How far the transfer in flight has got, and when the armed push is due.
	// Both change far too often to redraw the whole panel for, so they are read
	// by the two things that paint them rather than pushed through refreshUI().
	// When the vault was last checked against the record rather than against
	// the commit pointer.
	private lastVerifyAt = 0;
	private lastDeepVerifyAt = 0;

	// Focus and visibility both announce a return to the app, usually in the
	// same instant. One check is enough.
	private activating = false;

	private debugSaveTimer: number | null = null;

	private progress: SyncProgress | null = null;
	private pushDueAt: number | null = null;
	private pushWindowMs = 0;

	// The last error already announced. A failing token or an exhausted rate
	// limit repeats on every poll, and a notice each time would be unusable.
	private lastErrorMessage: string | null = null;

	// Consecutive rate-limit refusals. GitHub asks for an exponentially
	// increasing wait when a limit keeps being hit, so each one in a row doubles
	// the hold. Cleared by anything that succeeds.
	private rateLimitStreak = 0;

	constructor(
		private app: App,
		private settings: UltiSyncSettings,
		private stateStore: SyncStateStore,
		private state: SyncStateData,
		private setStatus: (status: SyncStatus, detail: string) => void,
		private refreshUI: () => void,
		/** Called far more often than refreshUI, for the pieces that can be
		 *  repainted on their own: the progress bar and the countdown. */
		private onProgress: () => void = () => undefined,
		/** Called for a problem that cannot clear on its own, never for one that
		 *  can. */
		private onRequiresAttention: (message: string) => void = () => undefined,
	) {}

	private get vault(): Vault {
		return this.app.vault;
	}

	getState(): SyncStateData {
		return this.state;
	}

	/** Whether a transfer or comparison holds the manager right now. */
	isRunning(): boolean {
		return this.running;
	}

	getActivity(): ActivityEntry[] {
		return this.activity;
	}

	/** What is moving right now, or null when nothing is. */
	getProgress(): SyncProgress | null {
		return this.progress;
	}

	/**
	 * The push waiting out its delay, or null when none is armed. Read on a
	 * timer by whatever is drawing the countdown, so it reports the remaining
	 * time rather than announcing each tick.
	 */
	getPushCountdown(): PushCountdown | null {
		if (this.pushDueAt === null) return null;
		const remaining = this.pushDueAt - Date.now();
		if (remaining <= 0) return null;
		return { remaining, total: this.pushWindowMs };
	}

	/**
	 * Reports file counts while a transfer runs. A job below both thresholds
	 * reports nothing at all: it finishes faster than the readout can be read,
	 * and a number that flashes past is worse than no number.
	 */
	private reportProgress(
		phase: SyncPhase,
		done: number,
		total: number,
		totalBytes: number,
	): void {
		const worthWatching =
			total >= PROGRESS_MIN_FILES || totalBytes >= PROGRESS_MIN_BYTES;
		const next = worthWatching && total > 0 ? { phase, done, total } : null;

		// Small transfers call this per file and change nothing; painting on
		// every one of them would be pure waste.
		if (next === null && this.progress === null) return;

		this.progress = next;
		this.onProgress();
	}

	private clearProgress(): void {
		if (this.progress === null) return;
		this.progress = null;
		this.onProgress();
	}

	/**
	 * Progress for work done outside this manager but shown alongside its own,
	 * such as a reset clearing the vault before it asks for a pull. Reported
	 * unconditionally: the caller has decided it is worth watching.
	 */
	setProgress(progress: SyncProgress | null): void {
		if (progress === null) {
			this.clearProgress();
			return;
		}
		this.progress = progress;
		this.onProgress();
	}

	/** A PullManager wired to report where it has got to. */
	private pullManager(github: GitHubClient): PullManager {
		return new PullManager(
			this.app,
			github,
			this.settings,
			(done, total, bytes) => this.reportProgress('pull', done, total, bytes),
			(path) => this.markSelfWrite(path),
		);
	}

	/** A PushManager wired the same way. */
	private pushManager(github: GitHubClient): PushManager {
		return new PushManager(this.vault, github, this.settings, (done, total, bytes) =>
			this.reportProgress('push', done, total, bytes),
		);
	}

	// Naming a note is the user finishing what Obsidian started. Until that
	// happens an empty new file is a placeholder and waits; afterwards it is an
	// ordinary new note and goes out on the usual delay, empty or not.
	markUserNamed(path: string): void {
		this.userNamed.add(normalizePath(path));
	}

	/** Flags paths the plugin is about to write, so the vault events that follow
	 *  are recognised as this plugin's own work rather than the user's. */
	markSelfWrite(...paths: string[]): void {
		const until = Date.now() + SELF_WRITE_GRACE_MS;
		for (const path of paths) {
			this.selfWrites.set(normalizePath(path), until);
		}
	}

	// Consulted by the vault event handlers. Without it a pull feeds itself: the
	// files it writes look exactly like edits the user just made, so the vault is
	// marked dirty and pushed straight back, and a rename it applies is recorded
	// as a local rename and declared to the other device as though this vault had
	// performed it.
	isSelfWrite(path: string): boolean {
		const key = normalizePath(path);
		const until = this.selfWrites.get(key);
		if (until === undefined) return false;
		if (Date.now() > until) {
			this.selfWrites.delete(key);
			return false;
		}
		return true;
	}

	// Newest first, capped. The side panel is the only reader, and it wants to
	// show what just happened without scrolling.
	private record(kind: ActivityKind, text: string): void {
		this.activity.unshift({ at: Date.now(), kind, text });
		if (this.activity.length > ACTIVITY_LIMIT) {
			this.activity.length = ACTIVITY_LIMIT;
		}
		this.debug(`[${kind}] ${text}`);
		this.refreshUI();
	}

	// Same information as the in-memory activity list, but written to disk. The
	// status panel is lost the moment the app closes or the device is out of
	// sight; this is what lets a sync that happened on a device nobody is
	// watching still be read back afterward.
	private debug(line: string): void {
		if (!this.state.debugLog) this.state.debugLog = [];
		this.state.debugLog.push(`${new Date().toISOString()} ${line}`);
		if (this.state.debugLog.length > DEBUG_LOG_LIMIT) {
			this.state.debugLog.splice(0, this.state.debugLog.length - DEBUG_LOG_LIMIT);
		}
		this.scheduleDebugSave();
	}

	// Every point that matters saves explicitly; the log alone can wait.
	private scheduleDebugSave(): void {
		if (this.debugSaveTimer !== null) return;
		this.debugSaveTimer = window.setTimeout(() => {
			this.debugSaveTimer = null;
			void this.stateStore.save(this.state);
		}, DEBUG_SAVE_DELAY_MS);
	}

	// Called from the vault's rename event, which is the only place the old and
	// new path are known together. Once the event is gone the old path is just a
	// file that is not there any more, indistinguishable from a deletion.
	recordRename(oldPath: string, newPath: string): void {
		const from = normalizePath(oldPath);
		const to = normalizePath(newPath);
		if (!from || !to || from === to) return;

		// A renamed folder arrives as one event, but every tracked file beneath it
		// moved too.
		const pairs: [string, string][] = [[from, to]];
		for (const trackedPath of Object.keys(this.state.trackedFiles)) {
			if (trackedPath.startsWith(`${from}/`)) {
				pairs.push([trackedPath, `${to}${trackedPath.slice(from.length)}`]);
			}
		}

		for (const [start, end] of pairs) {
			this.applyRenamePair(start, end);
		}
		void this.stateStore.save(this.state);
	}

	/** Collapses a chain of renames so the remote is told the original path. */
	private applyRenamePair(from: string, to: string): void {
		let origin = from;
		for (const [start, current] of Object.entries(this.state.pendingRenames)) {
			if (current === from) {
				origin = start;
				delete this.state.pendingRenames[start];
				break;
			}
		}

		// Renamed back to where it started, so there is nothing to declare.
		if (origin === to) {
			delete this.state.pendingRenames[origin];
			return;
		}
		if (!this.state.trackedFiles[origin]) return;
		this.state.pendingRenames[origin] = to;
	}

	/**
	 * Compares this vault against the repository before anything is linked.
	 * Holds the manager while it runs, so no poll or push reads the vault
	 * halfway through the comparison.
	 */
	async runSetupCheck(onProgress?: ProgressCallback): Promise<SetupCheckResult> {
		if (this.running) {
			throw new Error('UltiSync is busy. Try again when the current operation finishes.');
		}
		this.running = true;
		try {
			return await new SetupCheck(this.vault, this.getClient(), this.settings).run(
				(progress) => {
					// Sized by the bytes it has to read: a comparison that reads
					// nothing is over before a count could be read.
					this.reportProgress('check', progress.done, progress.total, progress.totalBytes);
					onProgress?.(progress);
				},
			);
		} finally {
			this.running = false;
			this.clearProgress();
		}
	}

	private get syncEnabled(): boolean {
		return this.settings.syncEnabled;
	}

	markDirty(): void {
		if (!this.syncEnabled) return;
		if (this.needsStartingPoint()) {
			this.dirty = true;
			return;
		}
		const wasClean = !this.dirty;
		this.dirty = true;
		this.setStatus('pending', 'Local changes pending.');
		if (wasClean) this.record('info', 'Local changes waiting to be pushed');
		this.scheduleDebouncedPush();
	}

	startPolling(): void {
		this.stopPolling();
		this.pollTimer = window.setInterval(() => {
			if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
				return;
			}
			if (!this.syncEnabled) return;
			if (Date.now() < this.syncHoldUntil) return;
			void this.checkRemote();
		}, PULL_INTERVAL_MS);
	}

	stopPolling(): void {
		if (this.pollTimer) {
			window.clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	async onActivation(): Promise<void> {
		if (!this.syncEnabled) return;
		if (this.activating) return;
		const last = this.state.lastRemoteCheck ? Date.parse(this.state.lastRemoteCheck) : 0;
		if (Date.now() - last < PULL_INTERVAL_MS) {
			return;
		}

		this.activating = true;
		try {
			await this.checkRemote();

			// A device that has been away is the one most likely to have missed
			// something, and the least likely to be in the middle of anything.
			// Rate-limited all the same: a window clicked in and out of every
			// few seconds should not pay for a tree read each time.
			if (this.running) return;
			if (Date.now() - this.lastDeepVerifyAt < DEEP_VERIFY_INTERVAL_MS) return;
			try {
				await this.deepVerify();
			} catch (error) {
				this.handleError(error);
			}
		} finally {
			this.activating = false;
		}
	}

	// True while this vault has never been linked to a commit. Everything
	// automatic stays inert until a starting point is chosen.
	needsStartingPoint(): boolean {
		return !this.state.lastSyncedCommit;
	}

	/**
	 * Links this vault to the repository by carrying out the plan the user
	 * chose from the setup comparison, in the one order that never loses a
	 * file by accident:
	 *
	 * 1. Files the comparison proved identical are recorded as synced; nothing
	 *    moves for them.
	 * 2. Whatever GitHub wins is downloaded, trashing the local loser first.
	 * 3. Files the user chose to drop from this vault are trashed.
	 * 4. The remote position is recorded.
	 * 5. Whatever this vault wins is pushed, in one commit that also removes
	 *    the files the user chose to drop from GitHub.
	 *
	 * Anything that goes wrong before the position is recorded leaves the
	 * vault unlinked, so the next attempt starts from the comparison again
	 * rather than from a half-recorded state.
	 */
	async adopt(result: SetupCheckResult, plan: SetupPlan): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.setStatus('syncing', 'Linking to GitHub...');
		try {
			const github = this.getClient();
			const ref = await github.getBranchReferenceOrNull(true);
			const remote: RemoteSnapshot = ref
				? await (async () => {
						const commit = await github.getCommit(ref.object.sha);
						return github.readTreeSnapshot(commit.sha, commit.tree.sha);
					})()
				: { commitSha: '', treeSha: '', entries: new Map() };

			// 1. Identical on both sides, as the comparison found. Checked
			// against the tree read just now, in case GitHub moved in between.
			for (const [path, proof] of Object.entries(result.identical)) {
				if (remote.entries.get(path)?.sha !== proof.remoteSha) continue;
				const file = this.vault.getAbstractFileByPath(path);
				this.state.trackedFiles[path] = {
					localHash: proof.localHash,
					remoteSha: proof.remoteSha,
					...(file instanceof TFile ? { mtime: file.stat.mtime, size: file.stat.size } : {}),
				};
			}

			// 2. GitHub's winners come down. The pull manager marks each write
			// as the plugin's own as it happens.
			const pull = this.pullManager(github);
			const toPull = plan.pull.filter((path) => remote.entries.has(path));
			let pulled = 0;
			if (toPull.length) {
				this.setStatus('pulling', `Downloading ${toPull.length} file(s) from GitHub...`);
				for (const path of plan.overwriteLocal) {
					const file = this.vault.getAbstractFileByPath(path);
					if (!(file instanceof TFile)) continue;
					this.markSelfWrite(path);
					await this.app.fileManager.trashFile(file);
				}
				const applied = await pull.applyRemoteChanges(remote, this.state, toPull, []);
				pulled = applied.pulled;
			}

			// 3. The vault's extras, when the user chose GitHub as the whole
			// truth. Each is marked as it goes; a mark made up front lapses
			// before a long list is through.
			let trashed = 0;
			if (plan.trashLocal.length) {
				const total = plan.trashLocal.length;
				this.setStatus('syncing', `Moving ${total} file(s) to the trash...`);
				this.setProgress({ phase: 'clear', done: 0, total });
				for (const path of plan.trashLocal) {
					const file = this.vault.getAbstractFileByPath(path);
					if (file instanceof TFile) {
						this.markSelfWrite(path);
						await this.app.fileManager.trashFile(file);
						delete this.state.trackedFiles[path];
						trashed++;
					}
					this.setProgress({ phase: 'clear', done: trashed, total });
				}
				this.clearProgress();
			}

			// 4. From here on the vault is linked. The files about to be removed
			// from GitHub leave the record now, so nothing between here and the
			// push can read them as files this vault has yet to fetch.
			const now = new Date().toISOString();
			const tree = treeMapOf(remote);
			for (const path of plan.deleteRemote) delete tree[path];
			this.state.lastSyncedCommit = remote.commitSha || null;
			this.state.lastSyncedTree = tree;
			this.state.lastRemoteCheck = now;
			if (pulled) this.state.lastSuccessfulPull = now;
			await this.stateStore.save(this.state);

			// 5. This vault's winners go up, and GitHub's extras go if asked.
			// The push finds every untracked local file itself; the seeding
			// above is what keeps it from re-reading the identical ones.
			let pushed = false;
			if (plan.push || remote.commitSha === '') {
				this.setStatus('pushing', 'Uploading this vault...');
				pushed = await this.performPush('adopt', {
					forceOverwrite: true,
					deletePaths: plan.deleteRemote,
				});
			} else {
				this.dirty = false;
				this.setStatus('synced', 'Linked to GitHub.');
			}

			// The position recorded in step 4 is the one the push built on, so
			// anything only GitHub has that the plan kept was fetched in step
			// 2. This is the safety net for a remote that moved in between.
			const recovered = await this.verifyNow();

			const parts: string[] = [];
			if (pulled + recovered) parts.push(`downloaded ${pulled + recovered} file(s)`);
			if (trashed) parts.push(`trashed ${trashed} file(s) here`);
			if (pushed) parts.push('uploaded this vault');
			if (plan.deleteRemote.length) parts.push(`removed ${plan.deleteRemote.length} file(s) from GitHub`);
			this.record('info', parts.length ? `Linked to GitHub: ${parts.join(', ')}` : 'Linked to GitHub');
			new Notice(
				parts.length
					? `UltiSync: linked to GitHub — ${parts.join(', ')}.`
					: 'UltiSync: linked to GitHub. Everything already matched.',
			);
			this.refreshUI();
		} catch (error) {
			// Unlinked again, so the next attempt runs the comparison afresh
			// rather than trusting a position that was never fully applied.
			this.state.lastSyncedCommit = null;
			this.state.lastSyncedTree = {};
			await this.stateStore.save(this.state);
			this.handleError(error);
		} finally {
			this.running = false;
			this.clearProgress();
		}
	}

	async initialPull(overwriteExisting = false): Promise<void> {
		if (this.running) {
			this.requested = true;
			return;
		}
		this.running = true;
		this.setStatus('pulling', 'Initial pull...');
		try {
			const github = this.getClient();
			const ref = await github.getBranchReference();
			const commit = await github.getCommit(ref.object.sha);
			const remote = await github.readTreeSnapshot(commit.sha, commit.tree.sha);

			const pull = this.pullManager(github);
			const result = await pull.performInitialPull(remote, this.state, overwriteExisting);

			const now = new Date().toISOString();
			this.state.lastSyncedCommit = remote.commitSha;
			this.state.lastSyncedTree = treeMapOf(remote);
			this.state.lastRemoteCheck = now;
			this.state.lastSuccessfulPull = now;
			await this.stateStore.save(this.state);

			this.dirty = false;
			this.setStatus('synced', `Initial pull complete: ${result.pulled} file(s).`);
			new Notice(
				`UltiSync: pulled ${result.pulled} file(s).` +
					(result.skipped
						? ` ${result.skipped} file(s) in the repository were skipped because their type is not in your Pull extensions.`
						: ''),
				result.skipped ? 12000 : undefined,
			);
			this.refreshUI();
		} catch (error) {
			this.handleError(error);
		} finally {
			this.running = false;
			this.clearProgress();
			await this.runRequestedIfNeeded();
		}
	}

	async syncNow(): Promise<void> {
		if (this.running) {
			this.requested = true;
			return;
		}
		this.running = true;
		this.setStatus('syncing', 'Synchronizing...');
		try {
			await this.syncInternal();
		} catch (error) {
			this.handleError(error);
		} finally {
			this.running = false;
			this.clearProgress();
			await this.runRequestedIfNeeded();
		}
	}

	async pullNow(): Promise<void> {
		if (this.running) {
			this.requested = true;
			return;
		}
		this.running = true;
		this.setStatus('pulling', 'Pulling...');
		try {
			await this.pullInternal();
		} catch (error) {
			this.handleError(error);
		} finally {
			this.running = false;
			this.clearProgress();
			await this.runRequestedIfNeeded();
		}
	}

	// The manual push. Unlike the debounced automatic push this carries
	// deletions, because a person pressing a button has an intent that a timer
	// does not, and deletions are still confirmed before a large batch is sent.
	async pushEverything(): Promise<void> {
		if (this.running) {
			this.requested = true;
			return;
		}
		this.running = true;
		this.setStatus('pushing', 'Pushing...');
		try {
			if (!this.state.lastSyncedCommit) {
				throw new Error(
					'This vault has not been linked to GitHub yet. Turn on automatic synchronization and choose a starting point first.',
				);
			}
			await this.performPush('manual');
		} catch (error) {
			this.handleError(error);
		} finally {
			this.running = false;
			this.clearProgress();
			await this.runRequestedIfNeeded();
		}
	}

	async pushNow(): Promise<void> {
		if (this.running) {
			this.requested = true;
			return;
		}
		this.running = true;
		this.setStatus('pushing', 'Pushing...');
		try {
			await this.pushInternal();
		} catch (error) {
			this.handleError(error);
			if (this.dirty && !this.needsStartingPoint()) {
				this.scheduleDebouncedPush();
			}
		} finally {
			this.running = false;
			this.clearProgress();
			await this.runRequestedIfNeeded();
		}
	}

	// Sync now is the only entry point that does both halves, and even here they
	// are two independent operations run in sequence, not one combined
	// procedure. It is the deliberate, full reconcile: the only place deletions
	// move in either direction.
	private async syncInternal(): Promise<void> {
		await this.pullInternal(true);
		await this.performPush('manual');
	}

	// Pull is how this device gets current. It runs on activation, on the poll
	// timer, and from sync now / pull now, never as a precondition of pushing.
	//
	// Deletions are applied here rather than only on an explicit sync. The
	// reason they were withheld was that a path missing from the remote tree was
	// indistinguishable from one this device had simply never pulled, and from
	// one a stale read had failed to mention. Neither is true any more:
	// lastSyncedTree says exactly what the remote held, and the comparison below
	// refuses to act at all unless the remote genuinely moved forward.
	private async pullInternal(allowDeletions = true): Promise<void> {
		const github = this.getClient();

		if (!this.state.lastSyncedCommit) {
			await this.initialPull();
			return;
		}

		const ref = await github.getBranchReference();
		const remoteHead = ref.object.sha;

		if (remoteHead === this.state.lastSyncedCommit) {
			// Asked for explicitly, so the pointer is not taken at its word.
			if (await this.verifyNow()) return;

			await this.pruneConflictsAgainstSyncedTree();
			this.state.lastRemoteCheck = new Date().toISOString();
			await this.stateStore.save(this.state);
			this.setStatus(
				Object.keys(this.state.conflicts).length ? 'conflict' : 'synced',
				'No remote changes.',
			);
			return;
		}

		const comparison = await this.compareOrDiverged(github, this.state.lastSyncedCommit, remoteHead);
		const relation = comparison.status;

		// A head that is behind or identical is a stale read, not a branch that
		// moved. Drop the cached ETag so the next poll asks for a fresh body.
		if (relation === 'identical' || relation === 'behind') {
			github.invalidateBranchCache();
			this.state.lastRemoteCheck = new Date().toISOString();
			await this.stateStore.save(this.state);
			this.setStatus(
				Object.keys(this.state.conflicts).length ? 'conflict' : 'synced',
				'No remote changes.',
			);
			return;
		}

		await this.reconcileRemoteAndLocal(
			remoteHead,
			github,
			allowDeletions,
			relation,
			renamesDeclaredIn(comparison.commits),
		);
	}

	/**
	 * How the remote head relates to the synced commit, with one answer for a
	 * commit GitHub no longer knows: "diverged". That happens when history was
	 * rewritten under this vault, or when a read lands on a replica that has
	 * not seen the commit yet. Either way the tree is still worth reconciling,
	 * with deletions withheld, and neither is a reason to switch sync off —
	 * which is what a bare 404 used to do.
	 */
	private async compareOrDiverged(
		github: GitHubClient,
		baseSha: string,
		headSha: string,
	): Promise<{ status: string; commits: { sha: string; message: string }[] }> {
		try {
			return await github.compareCommits(baseSha, headSha);
		} catch (error) {
			if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
			this.debug(
				`compare ${baseSha.slice(0, 12)}...${headSha.slice(0, 12)} answered 404; treating as diverged`,
			);
			github.invalidateBranchCache();
			return { status: 'diverged', commits: [] };
		}
	}

	private async pushInternal(): Promise<void> {
		if (!this.state.lastSyncedCommit) {
			throw new Error('Complete an initial pull before pushing.');
		}
		await this.performPush('automatic');
	}

	// Push stands alone. It reads the branch itself, builds its commit on top of
	// whatever the remote currently holds, and retries if the branch moves while
	// it works. It never pulls first: GitHub carries over every path this device
	// did not touch, so a change made elsewhere to a different file survives
	// untouched. Getting this vault current is the pull path's job.
	//
	// A large batch of deletions is confirmed the same way whatever started the
	// push. Withholding them on an automatic push and telling the user to press
	// Push instead only worked while that button was available, and it is
	// disabled precisely when synchronization is on.
	async performPush(
		trigger: PushTrigger = 'automatic',
		adoption: Pick<PushOptions, 'forceOverwrite' | 'deletePaths'> = {},
	): Promise<boolean> {
		// Nothing automatic runs while a push is in flight, however long it takes.
		this.syncHoldUntil = Date.now() + POLL_HOLD_AFTER_PUSH_MS;

		let landed: string | null = null;
		try {
			landed = await this.performPushInternal(trigger, adoption);
		} finally {
			// The settling period counts from the moment the push actually
			// finished. Arming it only at the start left a long push clear to be
			// followed immediately by another one.
			this.syncHoldUntil = Date.now() + POLL_HOLD_AFTER_PUSH_MS;
		}

		if (landed) await this.waitForBranchToCatchUp(landed);
		return landed !== null;
	}

	/**
	 * Replaces a blind wait with an answer.
	 *
	 * The hold after a push exists because GitHub's ref reads are eventually
	 * consistent: read too soon and you get the previous head, which reads as
	 * every file this device just pushed having been deleted. Waiting a fixed
	 * ten seconds was only ever a guess at how long that takes.
	 *
	 * Asking directly is better in both directions. GitHub usually agrees
	 * immediately, and the hold is released at once instead of idling. When it
	 * does lag, the wait lasts as long as the lag rather than as long as the
	 * guess, and the original ten seconds remains the ceiling.
	 */
	private async waitForBranchToCatchUp(commitSha: string): Promise<void> {
		const github = this.getClient();
		const deadline = Date.now() + POLL_HOLD_AFTER_PUSH_MS;

		for (const backoff of CONFIRM_BACKOFF_MS) {
			if (backoff) await sleep(backoff);
			if (Date.now() >= deadline) break;

			try {
				github.invalidateBranchCache();
				const ref = await github.getBranchReference(true);
				if (ref.object.sha === commitSha) {
					this.syncHoldUntil = 0;
					this.debug(`push confirmed on GitHub at ${commitSha.slice(0, 12)}`);
					return;
				}
			} catch {
				// A failure here is not the push failing; that already succeeded.
				// Fall through and let the ordinary poll surface any real problem.
				break;
			}
		}

		this.debug('push not confirmed within the settle window, holding for the full period');
	}

	/** Returns the commit this push created, or null when nothing was pushed. */
	private async performPushInternal(
		trigger: PushTrigger,
		adoption: Pick<PushOptions, 'forceOverwrite' | 'deletePaths'>,
	): Promise<string | null> {
		const github = this.getClient();
		const push = this.pushManager(github);

		const result = await push.push(this.state, {
			// Adoption is the one push that must not infer deletions: nothing
			// was tracked before it, so every absence is meaningless rather than
			// intentional. The ones it does carry were chosen by name.
			includeDeletions: trigger !== 'adopt',
			...adoption,
			userNamed: this.userNamed,
			confirmDeletions: (paths, reason) =>
				confirmWithModal(this.app, {
					title: `Delete ${paths.length} file(s) from GitHub?`,
					body:
						reason === 'empty-index'
							? [
									`You are attempting to delete ${paths.length} file(s) from GitHub.`,
									'This vault currently reports no files at all, which usually means it has not finished loading. Cancel unless you are certain.',
								]
							: `You are attempting to delete ${paths.length} file(s) from GitHub.`,
					list: paths,
					confirmLabel: 'Delete',
				}),
		});

		this.debug(`push trigger=${trigger}`);
		for (const line of result.trace) this.debug(`push-trace ${line}`);

		if (result.remote) {
			await this.pruneResolvedConflicts(result.remote);
			await this.recordCollisions(result.collisions, result.remote);
		}

		if (result.oversized.length) {
			const names = result.oversized.map(basename);
			this.record('error', `Too large for GitHub, not sent: ${names.join(', ')}`);
			new Notice(
				`UltiSync: ${result.oversized.length} file(s) are past GitHub's 100 MB limit and were not sent.\n\n` +
					listForPrompt(result.oversized) +
					'\n\nEverything else in this push went through.',
				15000,
			);
		}

		if (result.largeFiles.length) {
			this.record(
				'info',
				`${result.largeFiles.length} file(s) over ${megabytes(
					LARGE_FILE_WARN_BYTES,
				)} pushed: ${result.largeFiles.map(basename).join(', ')}`,
			);
		}

		if (result.withheldDeletions.length) {
			const held = result.withheldDeletions.length;
			this.record('info', `${held} deletion(s) cancelled`);
			new Notice(`UltiSync: kept ${held} file(s) on GitHub. Nothing was deleted.`);
		}

		if (result.deletedPaths.length) {
			this.record('push', `Removed ${result.deletedPaths.length} file(s) from GitHub`);
		}

		if (result.pushed && result.commitSha) {
			this.state.lastSuccessfulPush = new Date().toISOString();
			this.record('push', `Pushed ${result.changedCount} change(s) to GitHub`);

			// Only advance the synced position when the push started from the
			// commit this vault already knew about. Otherwise the next pull has to
			// reconcile the difference. A first commit into an empty repository
			// started from nothing, which is exactly what an unlinked vault knew.
			if (result.remote?.commitSha === (this.state.lastSyncedCommit ?? '')) {
				this.state.lastSyncedCommit = result.commitSha;
				const tree = treeMapOf(result.remote);
				for (const path of result.deletedPaths) delete tree[path];
				for (const [path, sha] of Object.entries(result.writtenShas)) {
					tree[path] = sha;
					this.userNamed.delete(path);
				}
				this.state.lastSyncedTree = tree;
			}
		}

		await this.pruneConflictsAgainstSyncedTree();
		this.state.lastRemoteCheck = new Date().toISOString();
		await this.stateStore.save(this.state);

		this.clearErrorLatch();
		this.dirty = false;
		// A push is the moment this vault's record of the remote is freshest,
		// and the moment it is most worth asking whether the vault matches it.
		this.lastVerifyAt = 0;
		if (result.deferredUntil !== null) {
			this.dirty = true;
			this.scheduleDeferredPush(result.deferredUntil);
		}

		const conflictCount = Object.keys(this.state.conflicts).length;
		this.setStatus(
			conflictCount ? 'conflict' : 'synced',
			conflictCount
				? `${conflictCount} conflict(s) need attention.`
				: result.pushed
					? `Pushed ${result.changedCount} change(s).`
					: 'Nothing to push.',
		);
		this.refreshUI();

		return result.pushed ? result.commitSha : null;
	}

	// A collision is the one thing GitHub cannot merge for us: the same file
	// changed here and there. The local file is left exactly as it is and the
	// remote version is brought down beside it.
	private async recordCollisions(paths: string[], remote: RemoteSnapshot): Promise<void> {
		if (!paths.length) return;

		const conflicts: ConflictRecord[] = [];
		for (const path of paths) {
			if (this.state.conflicts[path]) continue;

			const file = this.vault.getAbstractFileByPath(path);
			const localHash =
				file instanceof TFile ? await sha256(await this.vault.readBinary(file)) : null;
			const remoteEntry = remote.entries.get(path);

			conflicts.push({
				path,
				detectedAt: new Date().toISOString(),
				localHash,
				remoteSha: remoteEntry?.sha ?? null,
				remoteExists: Boolean(remoteEntry && remoteEntry.type === 'blob'),
				conflictCopyPath: null,
			});
		}

		await this.recordConflicts(conflicts, remote);
	}

	// Combines a file that changed here and on the remote. Returns true when the
	// vault now holds merged text; false means it is a genuine conflict.
	private async mergeDivergence(
		path: string,
		remote: RemoteSnapshot,
		github: GitHubClient,
	): Promise<boolean> {
		const file = this.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return false;

		const bytes = await this.vault.readBinary(file);
		const tracked = this.state.trackedFiles[path];
		const remoteEntry = remote.entries.get(path);

		const outcome = await attemptMerge(github, path, bytes, tracked, remoteEntry);
		if (!outcome || !remoteEntry?.sha) return false;

		this.markSelfWrite(path);
		await this.vault.process(file, () => outcome.merged);
		this.record('merge', `Merged remote edits into ${basename(path)}`);

		this.state.trackedFiles[path] = {
			localHash: await sha256(outcome.theirBytes),
			remoteSha: remoteEntry.sha,
		};
		this.markDirty();
		return true;
	}

	// Records tracking for paths whose local bytes already match the remote blob,
	// and drops them from the pending change sets so neither side acts on them.
	private reconcileIdentical(
		identical: IdenticalPaths,
		localChanged: Set<string>,
		remoteChanged: Set<string>,
	): void {
		for (const [path, entry] of identical) {
			this.state.trackedFiles[path] = {
				localHash: entry.localHash,
				remoteSha: entry.remoteSha,
			};
			localChanged.delete(path);
			remoteChanged.delete(path);
		}
	}

	// Pull only. This brings the vault up to the remote commit and never pushes;
	// outgoing changes are the debounced push's business.
	private async reconcileRemoteAndLocal(
		remoteHeadSha: string,
		github: GitHubClient,
		allowDeletions = false,
		relation = 'ahead',
		declaredRenames: Map<string, string> = new Map(),
	): Promise<void> {
		this.setStatus('pulling', 'Inspecting remote changes...');
		this.record('info', 'New changes on GitHub');

		const remoteCommit = await github.getCommit(remoteHeadSha);
		const remote = await github.readTreeSnapshot(remoteHeadSha, remoteCommit.tree.sha);
		await this.pruneResolvedConflicts(remote);

		const remoteChanged = this.remoteChangedAgainstState(remote);
		const remoteDeleted = this.remoteDeletedAgainstState(remote);
		this.debug(
			`pull-scan relation=${relation} remoteDeleted=[${[...remoteDeleted].join(
				', ',
			)}] remoteChanged=[${[...remoteChanged].join(', ')}]`,
		);

		const renames = this.detectRemoteRenames(remote, remoteDeleted, remoteChanged);
		for (const [from, to] of declaredRenames) {
			if (remoteDeleted.has(from) && remote.entries.has(to)) {
				renames.set(from, to);
			}
		}
		if (renames.size) {
			this.debug(
				`pull-renames detected=[${[...renames.entries()]
					.map(([from, to]) => `${from}->${to}`)
					.join(', ')}]`,
			);
		}

		const renamed = await this.applyRemoteRenames(
			renames,
			remote,
			remoteDeleted,
			remoteChanged,
		);
		this.debug(
			`pull-renames applied=${renamed} remoteDeletedAfter=[${[...remoteDeleted].join(', ')}]`,
		);

		const deletionsTrustworthy = allowDeletions && relation === 'ahead';
		if (allowDeletions && remoteDeleted.size && !deletionsTrustworthy) {
			new Notice(
				`UltiSync: the remote has diverged from this vault, so ${remoteDeleted.size} deletion(s) were not applied.`,
			);
		}

		const detector = new ChangeDetector(this.vault, this.settings);
		const local = await detector.detectLocalChanges(
			this.state,
			this.settings.pushExtensions,
			this.userNamed,
		);

		const conflictDetector = new ConflictDetector(this.vault, this.settings.ignoredPaths);
		const detection = await conflictDetector.detect(
			this.state,
			remote,
			local.modifiedOrCreated,
			remoteChanged,
			remoteDeleted,
		);
		this.reconcileIdentical(detection.identical, local.modifiedOrCreated, remoteChanged);

		const conflicts: ConflictRecord[] = [];
		for (const conflict of detection.conflicts) {
			if (await this.mergeDivergence(conflict.path, remote, github)) {
				remoteChanged.delete(conflict.path);
				continue;
			}
			conflicts.push(conflict);
		}
		await this.recordConflicts(conflicts, remote);

		const conflictPaths = new Set(conflicts.map((conflict) => conflict.path));
		const safeRemoteChanged = new Set(
			[...remoteChanged].filter((path) => !conflictPaths.has(path)),
		);
		const safeRemoteDeleted = deletionsTrustworthy
			? new Set([...remoteDeleted].filter((path) => !conflictPaths.has(path)))
			: new Set<string>();
		this.debug(
			`pull-delete-plan deletionsTrustworthy=${deletionsTrustworthy} conflictPaths=[${[
				...conflictPaths,
			].join(', ')}] safeRemoteDeleted=[${[...safeRemoteDeleted].join(', ')}]`,
		);

		this.markSelfWrite(...safeRemoteChanged, ...safeRemoteDeleted);
		const pull = this.pullManager(github);
		const pullResult = await pull.applyRemoteChanges(
			remote,
			this.state,
			safeRemoteChanged,
			safeRemoteDeleted,
		);
		this.debug(
			`pull-delete-result actuallyDeleted=[${[...pullResult.deletedPaths].join(
				', ',
			)}] pulledFileCount=${pullResult.pulled}`,
		);
		for (const line of pullResult.trace) this.debug(`pull-delete-trace ${line}`);

		// A deletion that was not applied has to stay in the recorded tree, or the
		// next pull would see it as already gone and never apply it.
		const nextTree = treeMapOf(remote);
		let carriedForward = 0;
		for (const path of remoteDeleted) {
			if (pullResult.deletedPaths.has(path)) continue;
			const previous = this.state.lastSyncedTree[path];
			if (previous === undefined) continue;
			nextTree[path] = previous;
			carriedForward++;
		}
		if (carriedForward) {
			this.record('info', `${carriedForward} remote deletion(s) not applied yet`);
		}

		const now = new Date().toISOString();
		this.clearErrorLatch();
		this.state.lastSyncedCommit = remoteHeadSha;
		this.state.lastSyncedTree = nextTree;
		this.state.lastRemoteCheck = now;
		this.state.lastSuccessfulPull = now;
		await this.stateStore.save(this.state);

		this.dirty = local.modifiedOrCreated.size > 0 || local.deleted.size > 0;
		if (this.dirty) {
			this.scheduleDebouncedPush();
		}

		this.setStatus(
			Object.keys(this.state.conflicts).length ? 'conflict' : 'synced',
			renamed
				? `Pulled ${pullResult.pulled} file(s), moved ${renamed}.`
				: `Pulled ${pullResult.pulled} file(s).`,
		);

		if (pullResult.pulled || renamed || pullResult.deletedPaths.size) {
			const parts: string[] = [];
			if (pullResult.pulled) parts.push(`${pullResult.pulled} file(s)`);
			if (renamed) parts.push(`${renamed} renamed`);
			if (pullResult.deletedPaths.size) parts.push(`${pullResult.deletedPaths.size} removed`);
			this.record('pull', `Pulled ${parts.join(', ')}`);
		}

		this.refreshUI();
	}

	private remoteChangedAgainstState(remote: RemoteSnapshot): Set<string> {
		const result = new Set<string>();
		const remoteExtensions = this.remoteTrackingExtensions();

		for (const [path, tracked] of Object.entries(this.state.trackedFiles)) {
			if (!matchesExtensions(path, remoteExtensions)) continue;
			if (isIgnoredPath(path, this.settings.ignoredPaths)) continue;

			const remoteEntry = remote.entries.get(path);
			if (remoteEntry && remoteEntry.type === 'blob' && remoteEntry.sha !== tracked.remoteSha) {
				result.add(path);
			}
		}

		for (const [path, entry] of remote.entries) {
			if (!matchesExtensions(path, remoteExtensions)) continue;
			if (isIgnoredPath(path, this.settings.ignoredPaths)) continue;
			if (entry.type === 'blob' && !this.state.trackedFiles[path]) {
				result.add(path);
			}
		}

		return result;
	}

	// A path was deleted when the tree this vault last synced to contained it and
	// the current tree does not. trackedFiles is deliberately not consulted here:
	// it holds only what this device happened to pull, which is what made a file
	// that was never this device's business look exactly like a deleted one.
	private remoteDeletedAgainstState(remote: RemoteSnapshot): Set<string> {
		const result = new Set<string>();
		const remoteExtensions = this.remoteTrackingExtensions();

		for (const path of Object.keys(this.state.lastSyncedTree)) {
			if (!matchesExtensions(path, remoteExtensions)) continue;
			if (isIgnoredPath(path, this.settings.ignoredPaths)) continue;
			if (!remote.entries.has(path)) {
				result.add(path);
			}
		}

		return result;
	}

	// A rename arrives at this device as one path vanishing and an unrelated path
	// appearing. Git does not record renames either: it recognises them by
	// noticing the content is unchanged, and the blob sha is precisely that
	// comparison, already computed by GitHub.
	//
	// A file renamed and edited in the same remote commit has a different sha
	// and is not matched. It falls through to delete-plus-download, which costs a
	// round trip and loses nothing.
	private detectRemoteRenames(
		remote: RemoteSnapshot,
		remoteDeleted: Set<string>,
		remoteChanged: Set<string>,
	): Map<string, string> {
		const renames = new Map<string, string>();
		if (!remoteDeleted.size) return renames;

		const arrivalsBySha = new Map<string, string[]>();
		for (const path of remoteChanged) {
			if (this.state.trackedFiles[path]) continue;
			const sha = remote.entries.get(path)?.sha;
			// Every empty file shares one sha, so matching on it would pair
			// unrelated paths.
			if (!sha || sha === EMPTY_BLOB_SHA) continue;

			const existing = arrivalsBySha.get(sha);
			if (existing) existing.push(path);
			else arrivalsBySha.set(sha, [path]);
		}
		if (!arrivalsBySha.size) return renames;

		const claimed = new Set<string>();
		for (const from of remoteDeleted) {
			const sha = this.state.lastSyncedTree[from];
			if (!sha || sha === EMPTY_BLOB_SHA) continue;

			const to = arrivalsBySha.get(sha)?.find((path) => !claimed.has(path));
			if (!to) continue;

			claimed.add(to);
			renames.set(from, to);
		}

		return renames;
	}

	// Moves the local file instead of deleting it and downloading a copy under
	// the new name. This runs on every pull, including automatic ones: a rename
	// preserves content, so unlike a deletion there is nothing here to withhold
	// until the user asks for it.
	private async applyRemoteRenames(
		renames: Map<string, string>,
		remote: RemoteSnapshot,
		remoteDeleted: Set<string>,
		remoteChanged: Set<string>,
	): Promise<number> {
		let renamed = 0;

		for (const [from, to] of renames) {
			const file = this.vault.getAbstractFileByPath(from);
			const sha = remote.entries.get(to)?.sha;
			const movable =
				file instanceof TFile &&
				!this.vault.getAbstractFileByPath(to) &&
				matchesExtensions(to, this.settings.pullExtensions) &&
				!isIgnoredPath(to, this.settings.ignoredPaths) &&
				isSafeVaultPath(to);
			if (!movable) continue;

			const tracked = this.state.trackedFiles[from];
			this.markSelfWrite(from, to);
			await this.ensureParentFolder(to);
			await this.vault.rename(file, to);
			delete this.state.trackedFiles[from];

			if (tracked && sha) {
				const moved = this.vault.getAbstractFileByPath(to);
				this.state.trackedFiles[to] = {
					...tracked,
					remoteSha: sha,
					...(moved instanceof TFile
						? { mtime: moved.stat.mtime, size: moved.stat.size }
						: {}),
				};
			}

			remoteDeleted.delete(from);
			remoteChanged.delete(to);
			renamed++;
		}

		return renamed;
	}

	private async ensureParentFolder(path: string): Promise<void> {
		const parts = normalizePath(path).split('/');
		parts.pop();
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.vault.getAbstractFileByPath(current)) {
				await this.vault.createFolder(current);
			}
		}
	}

	// Prunes conflicts using the recorded tree rather than a freshly fetched one.
	//
	// Conflicts were only ever re-examined during a reconcile or a push, and both
	// of those look at the remote as it was before the operation. Once the two
	// devices had settled and the branch went quiet, nothing looked again: the
	// "no remote changes" path returns early, so a conflict both sides had long
	// since resolved stayed pinned to the status bar indefinitely.
	//
	// lastSyncedTree already describes the remote at the synced commit, so this
	// costs no request at all.
	private async pruneConflictsAgainstSyncedTree(): Promise<void> {
		const paths = Object.keys(this.state.conflicts);
		if (!paths.length) return;

		let changed = false;
		for (const path of paths) {
			const remoteSha = this.state.lastSyncedTree[path] ?? null;
			if (await this.resolveConflictIfSettled(path, remoteSha)) {
				changed = true;
			}
		}

		if (changed) {
			await this.stateStore.save(this.state);
			this.refreshUI();
		}
	}

	// Conflict records are sticky: recordConflicts refuses to overwrite an
	// existing entry, and nothing else removes them. Without pruning, a conflict
	// that has since resolved itself pins the status bar to "conflict" forever
	// and leaves phantom entries in the conflict modal, where keep remote on a
	// path that no longer exists remotely would delete the local file.
	private async pruneResolvedConflicts(remote: RemoteSnapshot): Promise<void> {
		let changed = false;
		for (const path of Object.keys(this.state.conflicts)) {
			const remoteEntry = remote.entries.get(path);
			const remoteSha = remoteEntry?.type === 'blob' ? remoteEntry.sha : null;
			if (await this.resolveConflictIfSettled(path, remoteSha)) {
				changed = true;
			}
		}

		if (changed) {
			await this.stateStore.save(this.state);
			this.refreshUI();
		}
	}

	/**
	 * Drops one conflict record when it no longer describes a disagreement:
	 * either the path is gone from both sides, or both sides now hold identical
	 * bytes. Returns whether anything changed.
	 */
	private async resolveConflictIfSettled(
		path: string,
		remoteSha: string | null,
	): Promise<boolean> {
		const localFile = this.vault.getAbstractFileByPath(path);

		if (!(localFile instanceof TFile) && !remoteSha) {
			delete this.state.conflicts[path];
			return true;
		}

		if (localFile instanceof TFile && remoteSha) {
			const bytes = await this.vault.readBinary(localFile);
			if ((await gitBlobSha(bytes)) === remoteSha) {
				delete this.state.conflicts[path];
				this.state.trackedFiles[path] = {
					localHash: await sha256(bytes),
					remoteSha,
				};
				return true;
			}
		}

		return false;
	}

	private remoteTrackingExtensions(): string[] {
		return Array.from(
			new Set([...this.settings.pullExtensions, ...this.settings.pushExtensions]),
		);
	}

	private async recordConflicts(
		conflicts: ConflictRecord[],
		remote: RemoteSnapshot,
	): Promise<void> {
		for (const conflict of conflicts) {
			if (this.state.conflicts[conflict.path]) continue;
			conflict.conflictCopyPath = await this.createConflictCopy(conflict.path, remote);
			this.state.conflicts[conflict.path] = conflict;
		}

		if (conflicts.length) {
			await this.stateStore.save(this.state);
			for (const conflict of conflicts) {
				this.record('conflict', `Conflict in ${basename(conflict.path)}`);
			}
			new Notice(`${conflicts.length} synchronization conflict(s) detected.`);
		}
	}

	/** Brings the remote version down beside the local one, named per device. */
	private async createConflictCopy(
		path: string,
		remote: RemoteSnapshot,
	): Promise<string | null> {
		const remoteEntry = remote.entries.get(path);
		if (!remoteEntry || remoteEntry.type !== 'blob' || !remoteEntry.sha) {
			return null;
		}

		const blob = await this.getClient().getBlob(remoteEntry.sha);
		const bytes = base64ToArrayBuffer(blob.content);

		const dot = path.lastIndexOf('.');
		const stem = dot >= 0 ? path.slice(0, dot) : path;
		const ext = dot >= 0 ? path.slice(dot) : '';
		const copyPath = `${stem} (conflict - ${this.state.deviceId})${ext}`;

		if (this.vault.getAbstractFileByPath(copyPath)) {
			return copyPath;
		}

		await this.ensureParentFolder(copyPath);
		this.markSelfWrite(copyPath);
		await this.vault.createBinary(copyPath, bytes);
		return copyPath;
	}

	async keepLocal(path: string): Promise<void> {
		if (!this.state.conflicts[path]) return;
		delete this.state.conflicts[path];
		await this.stateStore.save(this.state);
		this.markDirty();
		await this.pushNow();
	}

	async keepRemote(path: string): Promise<void> {
		if (!this.state.conflicts[path]) return;

		const github = this.getClient();
		const ref = await github.getBranchReference();
		const commit = await github.getCommit(ref.object.sha);
		const remote = await github.readTreeSnapshot(ref.object.sha, commit.tree.sha);
		const pull = this.pullManager(github);

		if (remote.entries.has(path)) {
			await pull.applyRemoteChanges(remote, this.state, new Set([path]), new Set());
		} else {
			// Keeping a remote version that does not exist means deleting the local
			// file, which is worth asking about explicitly.
			const localFile = this.vault.getAbstractFileByPath(path);
			if (localFile instanceof TFile) {
				const proceed = await confirmWithModal(this.app, {
					title: 'Delete the local file?',
					body: [
						`"${path}" does not exist on GitHub.`,
						"Keeping the remote version means deleting your local copy. It is trashed, following Obsidian's own setting for deleted files.",
					],
					confirmLabel: 'Delete',
				});
				if (!proceed) {
					new Notice('UltiSync: kept the local file. Conflict left unresolved.');
					return;
				}
			}
			await pull.applyRemoteChanges(remote, this.state, new Set(), new Set([path]));
		}

		delete this.state.conflicts[path];
		this.state.lastSyncedCommit = ref.object.sha;
		this.state.lastSyncedTree = treeMapOf(remote);
		this.state.lastRemoteCheck = new Date().toISOString();
		await this.stateStore.save(this.state);

		this.setStatus(
			Object.keys(this.state.conflicts).length ? 'conflict' : 'synced',
			`Kept remote version of ${path}.`,
		);
		this.refreshUI();
	}

	async clearConflict(path: string): Promise<void> {
		delete this.state.conflicts[path];
		await this.stateStore.save(this.state);
		this.setStatus(
			Object.keys(this.state.conflicts).length ? 'conflict' : 'synced',
			'Conflict cleared.',
		);
		this.refreshUI();
	}

	getClient(): GitHubClient {
		return new GitHubClient(
			this.settings.githubOwner.trim(),
			this.settings.githubRepo.trim(),
			this.settings.token,
			this.settings.branch.trim() || 'main',
		);
	}

	// Re-arms for a specific moment rather than the usual delay, so a held-back
	// new file is reconsidered exactly when it becomes eligible.
	private scheduleDeferredPush(at: number): void {
		this.armPushTimer(
			Math.max(
				PUSH_DELAY_SECONDS * 1000,
				at - Date.now() + 250,
				this.syncHoldUntil - Date.now() + 250,
			),
			() => void this.pushNow(),
		);
	}

	private scheduleDebouncedPush(): void {
		this.armPushTimer(
			Math.max(PUSH_DELAY_SECONDS * 1000, this.syncHoldUntil - Date.now() + 250),
			() => void this.pushNow(),
		);
	}

	// An edit made while a push was in flight asks for another sync the instant
	// that push returns. Holding it until the push has settled is what keeps the
	// second attempt from reading a stale branch and calling the file a conflict.
	private scheduleHeldSync(): void {
		this.armPushTimer(Math.max(0, this.syncHoldUntil - Date.now()) + 250, () =>
			void this.syncNow(),
		);
	}

	// Re-arming restarts the countdown from full, which is the whole point of a
	// debounce: an edit made with two seconds left buys another five.
	private armPushTimer(delay: number, run: () => void): void {
		if (this.pushTimer) {
			window.clearTimeout(this.pushTimer);
		}
		this.pushDueAt = Date.now() + delay;
		this.pushWindowMs = delay;
		this.onProgress();
		this.pushTimer = window.setTimeout(() => {
			this.pushTimer = null;
			this.clearPushCountdown();
			run();
		}, delay);
	}

	private clearPushCountdown(): void {
		if (this.pushDueAt === null) return;
		this.pushDueAt = null;
		this.pushWindowMs = 0;
		this.onProgress();
	}

	/**
	 * Eligible files the recorded remote tree holds that this vault has never
	 * had. Pure arithmetic over state already in memory, so it costs no request
	 * and can run on the poll. The rule itself lives in Verify, where it can be
	 * tested without a vault behind it.
	 */
	private pathsNeverPulled(): string[] {
		return pathsNeverPulled({
			tree: this.state.lastSyncedTree,
			tracked: this.state.trackedFiles,
			pullExtensions: this.settings.pullExtensions,
			ignoredPaths: this.settings.ignoredPaths,
			isWindows: Platform.isWin,
			onDisk: (path) => this.vault.getAbstractFileByPath(path) instanceof TFile,
		});
	}

	/**
	 * The check the commit pointer cannot do. HEAD says whether the remote
	 * moved; it never says whether this vault holds what the remote holds.
	 * Starting from "Upload this vault" records the whole remote tree without
	 * downloading any of it, so the two answers differ from the first moment
	 * and no amount of polling would notice: the vault's own push is what set
	 * the commit it keeps comparing against.
	 *
	 * Returns how many files it recovered.
	 */
	async verifyNow(): Promise<number> {
		this.lastVerifyAt = Date.now();

		const missing = this.pathsNeverPulled();
		if (!missing.length) return 0;

		this.debug(`verify found ${missing.length} recorded file(s) that never arrived`);
		this.setStatus('pulling', `Fetching ${missing.length} file(s) that never arrived...`);
		return this.repairNeverPulled(missing);
	}

	/**
	 * Files this vault believes hold the remote's exact bytes, but whose size
	 * on disk says otherwise: the same blob sha recorded, the same size this
	 * vault wrote, and a byte count that does not match what GitHub has. That
	 * combination is a write that was cut short.
	 *
	 * Not repaired automatically. A file whose size has moved since this vault
	 * wrote it is an unpushed edit, and overwriting one of those to fix the
	 * other is not a trade worth making without being asked.
	 */
	private sizeMismatches(remote: RemoteSnapshot): string[] {
		const suspect: string[] = [];

		for (const [path, tracked] of Object.entries(this.state.trackedFiles)) {
			const entry = remote.entries.get(path);
			if (!entry || entry.type !== 'blob' || entry.size === undefined) continue;
			// A different blob is a difference this vault already knows how to
			// reconcile; only the ones it claims to match are interesting.
			if (entry.sha !== tracked.remoteSha) continue;

			const file = this.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;
			if (file.stat.size === entry.size) continue;
			// Moved since this vault wrote it: an edit, not a bad download.
			if (tracked.size !== undefined && file.stat.size !== tracked.size) continue;

			suspect.push(path);
		}

		return suspect;
	}

	/**
	 * The thorough version, for the moments worth spending a request on: how
	 * many eligible files the remote holds against how many this vault has, and
	 * whether the ones it has are the right size.
	 */
	async deepVerify(): Promise<void> {
		const head = this.state.lastSyncedCommit;
		if (!head) return;

		const github = this.getClient();
		const commit = await github.getCommit(head);
		const remote = await github.readTreeSnapshot(head, commit.tree.sha);

		const eligible = [...remote.entries.keys()].filter(
			(path) =>
				matchesExtensions(path, this.settings.pullExtensions) &&
				!isIgnoredPath(path, this.settings.ignoredPaths) &&
				isSafeVaultPath(path) &&
				isWritableOnThisPlatform(path, Platform.isWin),
		);
		const held = eligible.filter(
			(path) => this.vault.getAbstractFileByPath(path) instanceof TFile,
		).length;
		this.debug(`deep-verify eligible=${eligible.length} held=${held}`);

		const missing = this.pathsNeverPulled();
		if (missing.length) {
			this.setStatus('pulling', `Fetching ${missing.length} file(s) that never arrived...`);
			await this.repairNeverPulled(missing);
		}

		const suspect = this.sizeMismatches(remote);
		if (suspect.length) {
			this.debug(`deep-verify size mismatch=[${suspect.join(', ')}]`);
			this.record(
				'error',
				`${suspect.length} file(s) are a different size here than on GitHub: ${suspect
					.slice(0, 3)
					.map(basename)
					.join(', ')}`,
			);
		}

		this.lastVerifyAt = Date.now();
		this.lastDeepVerifyAt = Date.now();
	}

	/** Free when it finds nothing, which is the ordinary case. */
	private async verifyIfDue(): Promise<void> {
		if (Date.now() - this.lastVerifyAt < VERIFY_INTERVAL_MS) return;
		await this.verifyNow();
	}

	/**
	 * Downloads files this vault has never had. The recorded tree is taken at
	 * its word about what the remote holds, so only the blobs come off the
	 * wire, and nothing local is overwritten: every path here is one with no
	 * file on disk.
	 */
	private async repairNeverPulled(paths: string[]): Promise<number> {
		const head = this.state.lastSyncedCommit;
		if (!head) return 0;

		const github = this.getClient();
		const commit = await github.getCommit(head);
		const remote = await github.readTreeSnapshot(head, commit.tree.sha);

		this.markSelfWrite(...paths);
		const pull = this.pullManager(github);
		const result = await pull.applyRemoteChanges(remote, this.state, paths, []);
		for (const line of result.trace) this.debug(`verify-trace ${line}`);

		if (result.pulled) {
			this.state.lastSuccessfulPull = new Date().toISOString();
			this.record('pull', `Recovered ${result.pulled} file(s) that never arrived`);
		}
		await this.stateStore.save(this.state);

		this.setStatus(
			Object.keys(this.state.conflicts).length ? 'conflict' : 'synced',
			result.pulled ? `Recovered ${result.pulled} file(s).` : 'Nothing to recover.',
		);
		this.refreshUI();
		return result.pulled;
	}

	private async checkRemote(): Promise<void> {
		if (!this.syncEnabled) return;
		if (this.running) return;
		if (Date.now() < this.syncHoldUntil) return;
		if (!this.state.lastSyncedCommit) return;

		try {
			const github = this.getClient();
			const ref = await github.getBranchReference();
			this.state.lastRemoteCheck = new Date().toISOString();

			if (ref.object.sha !== this.state.lastSyncedCommit) {
				await this.pullNow();
			} else if (this.dirty && !this.pushTimer) {
				await this.pushNow();
			} else {
				// The commit pointer says there is nothing to do. That is exactly
				// when the vault has to be asked whether it agrees.
				await this.verifyIfDue();
			}
		} catch (error) {
			this.handleError(error);
		}
	}

	private async runRequestedIfNeeded(): Promise<void> {
		if (!this.requested) return;
		this.requested = false;

		if (Date.now() < this.syncHoldUntil) {
			this.scheduleHeldSync();
			return;
		}
		await this.syncNow();
	}

	private handleError(error: unknown): void {
		let message = 'Synchronization failed.';

		if (error instanceof GitHubApiError) {
			switch (error.status) {
				case 401:
					message =
						'Bad credentials, please recheck your GitHub creds. The token may have expired or been revoked. Sync has been turned off until you fix it.';
					break;
				case 403:
					message = `GitHub denied the request or rate limiting is active. — ${error.message}`;
					break;
				case 404:
					message =
						'Repository or branch not found. Check the owner and repository names, and that the token still has access to this repository. Sync has been turned off until you fix it.';
					break;
				case 409:
				case 422:
					message = `GitHub rejected the request: ${error.message}`;
					break;
				case 0:
					message = error.message;
					break;
				default:
					message = `GitHub request failed (HTTP ${error.status}): ${error.message}`;
			}
		} else if (error instanceof Error) {
			message = error.message;
		}

		// A rate limit is the one failure the plugin can make worse by retrying.
		// GitHub says to honour `retry-after`, otherwise wait for the window to
		// reset, and to back off exponentially while the limit keeps being hit.
		// The existing hold already gates polling and the debounced push, so
		// setting it is all that is needed to stop asking.
		if (isRateLimited(error)) {
			this.rateLimitStreak++;
			const base = rateLimitDelayMs(error);
			const wait = Math.min(
				base * 2 ** (this.rateLimitStreak - 1),
				MAX_RATE_LIMIT_HOLD_MS,
			);
			const resumesAt = Date.now() + wait;
			this.syncHoldUntil = Math.max(this.syncHoldUntil, resumesAt);
			message = `GitHub rate limit reached. Sync resumes at ${clockTime(resumesAt)}.`;
		}

		console.error('[UltiSync]', error);
		this.setStatus('error', message);

		const isRepeat = message === this.lastErrorMessage;
		this.lastErrorMessage = message;
		if (!isRepeat) {
			this.record('error', message);
			new Notice(`UltiSync: ${message}`, requiresUserAction(error) ? 15000 : undefined);
		}
		this.refreshUI();

		// Retrying is only worth doing for something that can clear on its own.
		// Being offline clears when the network returns, a rate limit clears with
		// time, and a moved branch clears on the next attempt. A rejected token
		// or an unreachable repository clears when a person does something about
		// it, so the plugin stops and says so rather than failing every five
		// seconds until someone notices.
		if (requiresUserAction(error)) {
			void this.stopIfUnreachable(error, message);
		}
	}

	/**
	 * A 401 is final. A 404 is only final when the repository itself answers
	 * it: GitHub also says 404 for a commit a replica has not seen yet, or one
	 * that history was rewritten away from, and neither is fixed by a person
	 * retyping a token. So the branch is read once more before sync is
	 * switched off on the strength of a 404.
	 */
	private async stopIfUnreachable(error: unknown, message: string): Promise<void> {
		if (error instanceof GitHubApiError && error.status === 404) {
			try {
				await this.getClient().getBranchReferenceOrNull(true);
				this.debug('404 was not the repository; leaving sync on');
				return;
			} catch {
				// The repository really is out of reach. Fall through.
			}
		}
		this.onRequiresAttention(message);
	}

	/** Called once anything succeeds, so the next failure is announced again. */
	private clearErrorLatch(): void {
		this.lastErrorMessage = null;
		this.rateLimitStreak = 0;
	}

	destroy(): void {
		this.stopPolling();
		if (this.pushTimer) {
			window.clearTimeout(this.pushTimer);
			this.pushTimer = null;
		}
		if (this.debugSaveTimer !== null) {
			window.clearTimeout(this.debugSaveTimer);
			this.debugSaveTimer = null;
			void this.stateStore.save(this.state);
		}
		this.clearPushCountdown();
		this.clearProgress();
	}
}
