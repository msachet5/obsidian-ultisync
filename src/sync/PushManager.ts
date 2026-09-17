import { TFile, Vault } from 'obsidian';
import {
	GitHubApiError,
	GitHubClient,
	NewTreeEntry,
	RemoteSnapshot,
	isMissingBranch,
	isTooLargeError,
} from '../github/GitHubClient';
import { devicePlatform } from '../platform';
import {
	EMPTY_TREE_SHA,
	UltiSyncSettings,
	LARGE_FILE_WARN_BYTES,
	MAX_BLOB_BYTES,
	SyncStateData,
	TrackedFile,
} from '../types';
import { isIgnoredPath, isSafeVaultPath, matchesExtensions } from '../vault/PathFilter';
import { bytesToBase64, gitBlobSha, sha256 } from '../vault/VaultScanner';
import { ChangeDetector } from './ChangeDetector';
import { attemptMerge } from './MergeAttempt';
import { RenamePair, formatRenameLine } from './RenameRecord';

const MAX_PUSH_ATTEMPTS = 8;
const PUSH_RETRY_BACKOFF_MS = [400, 900, 2000, 4000, 6000, 8000, 10000];

/** More deletions than this in one push are confirmed before they are sent. */
const BULK_DELETION_THRESHOLD = 20;

/** Git's mode for a non-executable file. Every entry the plugin writes is one. */
const FILE_MODE = '100644';

export interface PushOptions {
	includeDeletions: boolean;
	/** Paths the user renamed themselves, exempt from the new-file settle delay. */
	userNamed?: Set<string>;
	/**
	 * Sends an untracked local file as it is even when GitHub holds a
	 * different version, instead of merging or reporting a collision. Only the
	 * adoption push sets this: the setup check has just shown the user exactly
	 * which files differ, and they chose this vault as the winner.
	 */
	forceOverwrite?: boolean;
	/**
	 * Paths to remove from GitHub in this commit whatever the vault holds.
	 * Already confirmed by whoever asked, so they bypass the deletion screen.
	 */
	deletePaths?: string[];
	/**
	 * Asked before a batch of deletions is sent. "empty-index" is the more
	 * alarming case: the vault reports nothing at all, which usually means it
	 * has not finished loading rather than that everything was deleted.
	 *
	 * Asynchronous because the answer comes from a modal, which cannot reply
	 * before the frame it was opened in has ended.
	 */
	confirmDeletions?: (paths: string[], reason: 'bulk' | 'empty-index') => Promise<boolean>;
}

export interface PushResult {
	pushed: boolean;
	changedCount: number;
	commitSha: string | null;
	collisions: string[];
	withheldDeletions: string[];
	/** Files GitHub will not accept at their size. Named rather than retried. */
	oversized: string[];
	/** Files past GitHub's warning threshold that were sent anyway. */
	largeFiles: string[];
	remote: RemoteSnapshot | null;
	deletedPaths: string[];
	writtenShas: Record<string, string>;
	deferredUntil: number | null;
	trace: string[];
}

interface PushPlan {
	entries: NewTreeEntry[];
	collisions: string[];
	oversized: string[];
	largeFiles: string[];
	deletedPaths: string[];
	withheldDeletions: string[];
	renamedPaths: string[];
	pushedTracking: Map<string, TrackedFile>;
	deferredUntil: number | null;
	trace: string[];
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function backoffFor(attempt: number): number {
	const last = PUSH_RETRY_BACKOFF_MS.length - 1;
	return PUSH_RETRY_BACKOFF_MS[attempt - 1] ?? PUSH_RETRY_BACKOFF_MS[last] ?? 10000;
}

function isBranchMovedError(error: unknown): boolean {
	return error instanceof GitHubApiError && (error.status === 422 || error.status === 409);
}

/**
 * True when applying these entries would leave nothing behind. GitHub's
 * create-tree endpoint 404s on a tree with no entries, so that case has to be
 * spotted in advance and answered with the known empty-tree sha.
 */
function resultsInEmptyTree(remote: RemoteSnapshot, entries: NewTreeEntry[]): boolean {
	if (!entries.length) return false;
	if (entries.some((entry) => entry.sha !== null)) return false;

	const deleted = new Set(entries.map((entry) => entry.path));
	for (const path of remote.entries.keys()) {
		if (!deleted.has(path)) return false;
	}
	return true;
}

function formatTimestamp(date: Date): string {
	const pad = (value: number): string => value.toString().padStart(2, '0');
	const day = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-');
	const time = [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join(':');
	return `${day} ${time}`;
}

function buildCommitMessage(
	renamedPaths: string[],
	pendingRenames: Record<string, string>,
): string {
	const header = `Sync from ${devicePlatform()} at ${formatTimestamp(new Date())}`;

	const pairs = renamedPaths.flatMap<RenamePair>((from) => {
		const to = pendingRenames[from];
		return typeof to === 'string' ? [[from, to]] : [];
	});
	if (!pairs.length) return header;

	return `${header}\n${formatRenameLine(pairs)}`;
}

export class PushManager {
	constructor(
		private vault: Vault,
		private github: GitHubClient,
		private settings: UltiSyncSettings,
		/** Called as each candidate file is taken up, so a long push can say
		 *  where it is. The byte total decides whether it is worth saying. */
		private onProgress: (done: number, total: number, totalBytes: number) => void = () =>
			undefined,
	) {}

	// Pushes local changes without pulling first.
	//
	// The merge happens on GitHub's side: the new tree is built with the remote's
	// current tree as its base and carries entries only for the files this device
	// touched. Every other path, including files another device just changed, is
	// inherited untouched. Two devices editing different files therefore merge
	// cleanly with no coordination at all.
	//
	// The one case that cannot be resolved this way is the same file changed in
	// both places. Those paths are detected here, withheld from the commit, and
	// returned as collisions.
	async push(state: SyncStateData, options: PushOptions): Promise<PushResult> {
		if (this.settings.pushExtensions.length === 0) {
			return this.emptyResult();
		}

		let lastError: unknown = null;
		let staleReads = 0;

		for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
			const ref = await this.github.getBranchReferenceOrNull(attempt > 1);
			// No branch means an empty repository, so this push writes the history
			// rather than building on it.
			if (ref === null) {
				return this.pushInitialCommit(state, options);
			}
			const headSha = ref.object.sha;

			if (await this.github.isStaleHead(headSha)) {
				staleReads++;
				if (attempt < MAX_PUSH_ATTEMPTS) {
					await sleep(backoffFor(attempt));
					continue;
				}
			}

			const headCommit = await this.github.getCommit(headSha);
			const remote = await this.github.readTreeSnapshot(headSha, headCommit.tree.sha);
			const plan = await this.planPush(state, remote, options);

			if (!plan.entries.length) {
				return {
					pushed: false,
					changedCount: 0,
					commitSha: null,
					collisions: plan.collisions,
					oversized: plan.oversized,
					largeFiles: plan.largeFiles,
					withheldDeletions: plan.withheldDeletions,
					remote,
					deletedPaths: [],
					writtenShas: {},
					deferredUntil: plan.deferredUntil,
					trace: plan.trace,
				};
			}

			const emptying = resultsInEmptyTree(remote, plan.entries);
			if (emptying) {
				plan.trace.push(
					"this commit removes every remaining file — using the empty-tree sha directly, GitHub's create-tree endpoint 404s on that case",
				);
			}
			const treeSha = emptying
				? EMPTY_TREE_SHA
				: (await this.github.createTree(remote.treeSha, plan.entries)).sha;

			const message = buildCommitMessage(plan.renamedPaths, state.pendingRenames);
			const commit = await this.github.createCommit(message, treeSha, headSha);

			try {
				await this.github.updateReference(ref, commit.sha);
			} catch (error) {
				if (isBranchMovedError(error) && attempt < MAX_PUSH_ATTEMPTS) {
					lastError = error;
					await sleep(backoffFor(attempt));
					continue;
				}
				throw error;
			}

			for (const path of plan.deletedPaths) {
				delete state.trackedFiles[path];
			}
			for (const path of plan.renamedPaths) {
				delete state.pendingRenames[path];
			}
			for (const [path, tracked] of plan.pushedTracking) {
				state.trackedFiles[path] = tracked;
			}

			return {
				pushed: true,
				changedCount: plan.entries.length,
				commitSha: commit.sha,
				collisions: plan.collisions,
				oversized: plan.oversized,
				largeFiles: plan.largeFiles,
				withheldDeletions: plan.withheldDeletions,
				remote,
				deferredUntil: plan.deferredUntil,
				deletedPaths: [...plan.deletedPaths, ...plan.renamedPaths],
				writtenShas: Object.fromEntries(
					[...plan.pushedTracking].flatMap(([path, tracked]) =>
						tracked.remoteSha ? [[path, tracked.remoteSha]] : [],
					),
				),
				trace: plan.trace,
			};
		}

		throw new Error(
			staleReads >= MAX_PUSH_ATTEMPTS - 1
				? `GitHub kept returning a branch position older than this device's own last push, across ${MAX_PUSH_ATTEMPTS} attempts. Nothing was force-pushed and your changes are still local. This usually clears within a minute, and the next push will send them.`
				: `The branch moved ${MAX_PUSH_ATTEMPTS} times while this push was being built, so it was abandoned rather than force-pushed. Your changes are still local and the next push will send them.` +
					(lastError instanceof Error ? ` (${lastError.message})` : ''),
		);
	}

	/**
	 * The first commit in a repository that has none. There is no base tree to
	 * inherit from and no parent to build on, so the tree is written whole and
	 * the branch is created rather than moved.
	 */
	private async pushInitialCommit(
		state: SyncStateData,
		options: PushOptions,
	): Promise<PushResult> {
		const empty: RemoteSnapshot = {
			commitSha: '',
			treeSha: EMPTY_TREE_SHA,
			entries: new Map(),
		};
		const plan = await this.planPush(state, empty, options);
		const trace = [...plan.trace, 'repository had no commits, creating the first one'];

		const additions = plan.entries.filter((entry) => entry.sha !== null);
		if (!additions.length) {
			return {
				...this.emptyResult(),
				oversized: plan.oversized,
				largeFiles: plan.largeFiles,
				remote: empty,
				trace,
			};
		}

		const tree = await this.github.createTree(null, additions);
		const commit = await this.github.createCommit(
			buildCommitMessage(plan.renamedPaths, state.pendingRenames),
			tree.sha,
			null,
		);

		try {
			await this.github.createReference(commit.sha);
		} catch (error) {
			// Another device created the branch first; the ordinary retry loop
			// will now find it and build on top instead.
			if (isMissingBranch(error) || isBranchMovedError(error)) {
				return this.push(state, options);
			}
			throw error;
		}

		for (const [path, tracked] of plan.pushedTracking) {
			state.trackedFiles[path] = tracked;
		}

		return {
			pushed: true,
			changedCount: additions.length,
			commitSha: commit.sha,
			collisions: plan.collisions,
			oversized: plan.oversized,
			largeFiles: plan.largeFiles,
			withheldDeletions: [],
			remote: empty,
			deletedPaths: [],
			writtenShas: Object.fromEntries(
				[...plan.pushedTracking].flatMap(([path, tracked]) =>
					tracked.remoteSha ? [[path, tracked.remoteSha]] : [],
				),
			),
			deferredUntil: plan.deferredUntil,
			trace,
		};
	}

	private async planPush(
		state: SyncStateData,
		remote: RemoteSnapshot,
		options: PushOptions,
	): Promise<PushPlan> {
		const detector = new ChangeDetector(this.vault, this.settings);
		const detected = await detector.detectLocalChanges(
			state,
			this.settings.pushExtensions,
			options.userNamed,
		);

		const trace = [
			`vault rescan found deleted=[${[...detected.deleted].join(', ')}] modifiedOrCreated=[${[
				...detected.modifiedOrCreated,
			].join(', ')}]`,
		];

		const entries: NewTreeEntry[] = [];
		const collisions: string[] = [];
		const oversized: string[] = [];
		const largeFiles: string[] = [];
		const deletedPaths: string[] = [];
		const withheldDeletions: string[] = [];
		const renamedPaths: string[] = [];
		const pushedTracking = new Map<string, TrackedFile>();

		// Counted over every candidate rather than only the ones that turn out to
		// need uploading: the files that are skipped are skipped after they have
		// been read and hashed, which is most of the wait on a large vault.
		const candidates = detected.modifiedOrCreated.size;
		// Read from the cached stats rather than the files, so sizing the job up
		// front costs nothing.
		let candidateBytes = 0;
		for (const path of detected.modifiedOrCreated) {
			const file = this.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) candidateBytes += file.stat.size;
		}

		let considered = 0;
		this.onProgress(0, candidates, candidateBytes);

		for (const path of detected.modifiedOrCreated) {
			this.onProgress(++considered, candidates, candidateBytes);
			if (!this.isPushable(path)) continue;

			const file = this.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;

			// Reading and base64-encoding a file GitHub is certain to refuse costs
			// the whole upload to earn the refusal, so the size is checked first.
			if (file.stat.size > MAX_BLOB_BYTES) {
				oversized.push(path);
				trace.push(
					`${path}: ${file.stat.size} bytes is past GitHub's 100 MiB limit, not sent`,
				);
				continue;
			}
			if (file.stat.size >= LARGE_FILE_WARN_BYTES) {
				largeFiles.push(path);
			}

			const bytes = await this.vault.readBinary(file);
			const localBlobSha = await gitBlobSha(bytes);
			const remoteEntry = remote.entries.get(path);
			const tracked = state.trackedFiles[path];

			// The remote already holds exactly these bytes, so only the local
			// bookkeeping was out of date.
			if (remoteEntry?.sha === localBlobSha) {
				state.trackedFiles[path] = {
					localHash: await sha256(bytes),
					remoteSha: localBlobSha,
					mtime: file.stat.mtime,
					size: file.stat.size,
				};
				continue;
			}

			const remoteIsUnknown =
				remoteEntry !== undefined && (!tracked || tracked.remoteSha !== remoteEntry.sha);

			if (remoteIsUnknown && options.forceOverwrite) {
				trace.push(`${path}: differs from GitHub, sent as-is (this vault chosen as winner)`);
			} else if (remoteIsUnknown) {
				const outcome = await attemptMerge(this.github, path, bytes, tracked, remoteEntry);
				if (!outcome) {
					collisions.push(path);
					continue;
				}

				await this.vault.process(file, () => outcome.merged);
				const mergedBytes = await this.vault.readBinary(file);
				const mergedBlob = await this.createBlobOrSkip(
					path,
					mergedBytes,
					oversized,
					trace,
				);
				if (!mergedBlob) continue;

				entries.push({ path, mode: FILE_MODE, type: 'blob', sha: mergedBlob.sha });
				pushedTracking.set(path, {
					localHash: await sha256(mergedBytes),
					remoteSha: mergedBlob.sha,
					mtime: file.stat.mtime,
					size: file.stat.size,
				});
				continue;
			}

			const blob = await this.createBlobOrSkip(path, bytes, oversized, trace);
			if (!blob) continue;
			entries.push({ path, mode: FILE_MODE, type: 'blob', sha: blob.sha });
			pushedTracking.set(path, {
				localHash: await sha256(bytes),
				remoteSha: blob.sha,
				mtime: file.stat.mtime,
				size: file.stat.size,
			});
		}

		// A rename is sent as a deletion of the old path. The new path arrives
		// through the ordinary modified/created route above.
		const renamedAway = new Set<string>();
		for (const [from, to] of Object.entries(state.pendingRenames ?? {})) {
			if (!this.isPushable(from)) continue;

			const destination = this.vault.getAbstractFileByPath(to);
			if (!(destination instanceof TFile)) {
				trace.push(
					`pendingRename ${from} -> ${to}: destination not resolvable via getAbstractFileByPath (got ${
						destination === null ? 'null' : typeof destination
					}), dropped WITHOUT pushing a deletion for ${from}`,
				);
				delete state.pendingRenames[from];
				continue;
			}

			renamedAway.add(from);
			const remoteEntry = remote.entries.get(from);
			if (!remoteEntry) {
				deletedPaths.push(from);
				renamedPaths.push(from);
				continue;
			}

			// The old path changed remotely since this device last saw it, so the
			// rename is not allowed to remove someone else's edit.
			const tracked = state.trackedFiles[from];
			if (tracked?.remoteSha && remoteEntry.sha !== tracked.remoteSha) {
				continue;
			}

			entries.push({ path: from, mode: FILE_MODE, type: 'blob', sha: null });
			deletedPaths.push(from);
			renamedPaths.push(from);
		}

		const candidateDeletions = [...detected.deleted].filter(
			(path) => this.isPushable(path) && !renamedAway.has(path),
		);
		for (const path of detected.deleted) {
			if (candidateDeletions.includes(path)) continue;
			trace.push(
				`${path}: vault reports it deleted, but excluded from push — isPushable=${this.isPushable(
					path,
				)}, renamedAway=${renamedAway.has(path)}`,
			);
		}

		if (candidateDeletions.length) {
			const verdict = await this.screenDeletions(candidateDeletions, state, options);
			trace.push(
				`screenDeletions candidates=[${candidateDeletions.join(', ')}] allowed=${
					verdict.allowed
				} includeDeletions=${options.includeDeletions} bulkThreshold=${BULK_DELETION_THRESHOLD}`,
			);

			if (verdict.allowed) {
				for (const path of candidateDeletions) {
					const remoteEntry = remote.entries.get(path);
					if (!remoteEntry) {
						trace.push(`${path}: already absent on remote, bookkeeping only`);
						deletedPaths.push(path);
						continue;
					}

					const tracked = state.trackedFiles[path];
					if (tracked?.remoteSha && remoteEntry.sha !== tracked.remoteSha) {
						trace.push(
							`${path}: remote changed since last seen, treated as collision — not deleted`,
						);
						collisions.push(path);
						continue;
					}

					trace.push(`${path}: queued for deletion in this commit`);
					entries.push({ path, mode: FILE_MODE, type: 'blob', sha: null });
					deletedPaths.push(path);
				}
			} else {
				withheldDeletions.push(...candidateDeletions);
			}
		}

		// Deletions the caller decided on, not ones the vault implied. They are
		// screened by whoever asked for them, so they go straight in.
		const queued = new Set(entries.map((entry) => entry.path));
		for (const path of options.deletePaths ?? []) {
			if (queued.has(path)) continue;
			if (!remote.entries.has(path)) {
				trace.push(`${path}: asked to delete, already absent on remote`);
				continue;
			}
			trace.push(`${path}: deleted on request`);
			entries.push({ path, mode: FILE_MODE, type: 'blob', sha: null });
			deletedPaths.push(path);
			queued.add(path);
		}

		const deferredUntil = detected.deferred.size
			? Math.min(...detected.deferred.values())
			: null;

		return {
			entries,
			collisions,
			oversized,
			largeFiles,
			deletedPaths,
			withheldDeletions,
			renamedPaths,
			pushedTracking,
			deferredUntil,
			trace,
		};
	}

	/**
	 * Uploads one file's bytes, or reports it as oversized and returns null.
	 *
	 * The size check before this catches everything GitHub documents, but the
	 * documented limit is on the file while the request carries it base64
	 * encoded, about a third larger. A refusal on that ground is one file's
	 * problem, so it is named and the rest of the push continues rather than the
	 * whole commit failing on it. Anything else is rethrown untouched.
	 */
	private async createBlobOrSkip(
		path: string,
		bytes: ArrayBuffer,
		oversized: string[],
		trace: string[],
	): Promise<{ sha: string } | null> {
		try {
			return await this.github.createBlob(bytesToBase64(bytes), 'base64');
		} catch (error) {
			if (!isTooLargeError(error)) throw error;
			oversized.push(path);
			trace.push(
				`${path}: GitHub refused the blob for its size (${
					error instanceof Error ? error.message : 'no message'
				}), not sent`,
			);
			return null;
		}
	}

	// Decides whether a set of apparent local deletions may be sent at all.
	// This guards what this device sends, not what it accepts: deletions
	// arriving from the repository are applied on their own terms, however many
	// there are, because they were already someone's deliberate decision.
	private async screenDeletions(
		paths: string[],
		state: SyncStateData,
		options: PushOptions,
	): Promise<{ allowed: boolean }> {
		if (!options.includeDeletions) {
			return { allowed: false };
		}

		// An empty vault alongside a populated tracking table is an index that has
		// not finished building, never an instruction to delete everything.
		const localCount = this.vault
			.getFiles()
			.filter((file) => matchesExtensions(file.path, this.settings.pushExtensions)).length;
		if (localCount === 0 && Object.keys(state.trackedFiles).length > 0) {
			return { allowed: (await options.confirmDeletions?.(paths, 'empty-index')) ?? false };
		}

		if (paths.length > BULK_DELETION_THRESHOLD) {
			return { allowed: (await options.confirmDeletions?.(paths, 'bulk')) ?? false };
		}

		return { allowed: true };
	}

	private isPushable(path: string): boolean {
		return (
			isSafeVaultPath(path) &&
			!isIgnoredPath(path, this.settings.ignoredPaths) &&
			matchesExtensions(path, this.settings.pushExtensions)
		);
	}

	private emptyResult(): PushResult {
		return {
			pushed: false,
			changedCount: 0,
			commitSha: null,
			collisions: [],
			oversized: [],
			largeFiles: [],
			withheldDeletions: [],
			remote: null,
			deletedPaths: [],
			writtenShas: {},
			deferredUntil: null,
			trace: ['no pushExtensions configured — nothing is ever pushed'],
		};
	}
}
