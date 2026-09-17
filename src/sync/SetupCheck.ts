import { TFile, Vault } from 'obsidian';
import { GitHubClient, RemoteSnapshot } from '../github/GitHubClient';
import { UltiSyncSettings } from '../types';
import { isIgnoredPath, matchesExtensions, normalizePath } from '../vault/PathFilter';
import { gitBlobSha, sha256 } from '../vault/VaultScanner';

/**
 * How this vault stands against the repository, before anything is linked.
 *
 * There is no common ancestor at this point, so "clean" can only mean that no
 * single path differs on both sides. A path that exists in both places with
 * different content cannot be reconciled without choosing a loser, which is
 * exactly the decision that has to go to the user.
 */
export type SetupRelation =
	| 'up-to-date'
	| 'remote-empty'
	| 'remote-ahead'
	| 'local-ahead'
	| 'both-ahead'
	| 'diverged';

export interface SetupCheckResult {
	relation: SetupRelation;
	commitSha: string;
	/** Paths only this vault has. */
	localOnly: string[];
	/** Paths only the repository has. */
	remoteOnly: string[];
	/** Paths both hold with different content. These are what make it dirty. */
	conflicting: string[];
	/**
	 * Paths both hold with the same bytes, with what a tracking record needs.
	 * The comparison had to hash them anyway; recording the answer lets the
	 * adoption mark them synced without reading them a second time.
	 */
	identical: Record<string, { remoteSha: string; localHash: string }>;
	localCount: number;
	remoteCount: number;
	/** Bytes actually read to settle same-size comparisons. */
	bytesHashed: number;
}

export interface CheckProgress {
	done: number;
	total: number;
	path: string;
	/** Bytes that will have to be read to settle the same-size comparisons. */
	totalBytes: number;
}

/** A comparison is cheap until it has to read files; this reports when it does. */
export type ProgressCallback = (progress: CheckProgress) => void;

export function summarize(result: SetupCheckResult): string {
	const { localOnly, remoteOnly, conflicting } = result;
	const parts = [
		`${remoteOnly.length} only on GitHub`,
		`${localOnly.length} only here`,
		`${conflicting.length} differing`,
	];
	return parts.join(', ');
}

export class SetupCheck {
	constructor(
		private vault: Vault,
		private github: GitHubClient,
		private settings: UltiSyncSettings,
	) {}

	async run(onProgress?: ProgressCallback): Promise<SetupCheckResult> {
		// A repository with no commits has no branch to read. That is not an
		// error, it just means everything here is new.
		const ref = await this.github.getBranchReferenceOrNull(true);
		if (ref === null) {
			return this.compare(
				{ commitSha: '', treeSha: '', entries: new Map() },
				onProgress,
			);
		}
		const commit = await this.github.getCommit(ref.object.sha);
		const remote = await this.github.readTreeSnapshot(commit.sha, commit.tree.sha);
		return this.compare(remote, onProgress);
	}

	private eligibleLocalFiles(): Map<string, TFile> {
		const extensions = Array.from(
			new Set([...this.settings.pullExtensions, ...this.settings.pushExtensions]),
		);
		const files = new Map<string, TFile>();
		for (const file of this.vault.getFiles()) {
			const path = normalizePath(file.path);
			if (
				matchesExtensions(path, extensions) &&
				!isIgnoredPath(path, this.settings.ignoredPaths)
			) {
				files.set(path, file);
			}
		}
		return files;
	}

	private async compare(
		remote: RemoteSnapshot,
		onProgress?: ProgressCallback,
	): Promise<SetupCheckResult> {
		const local = this.eligibleLocalFiles();
		const extensions = Array.from(
			new Set([...this.settings.pullExtensions, ...this.settings.pushExtensions]),
		);

		const localOnly: string[] = [];
		const remoteOnly: string[] = [];
		const conflicting: string[] = [];
		const identical: SetupCheckResult['identical'] = {};
		let bytesHashed = 0;

		// Only paths present on both sides can need hashing, so the expensive
		// work is bounded by the overlap rather than by the size of the vault.
		const shared: { path: string; file: TFile; sha: string; size?: number }[] = [];

		for (const [path, file] of local) {
			const entry = remote.entries.get(path);
			if (!entry) {
				localOnly.push(path);
				continue;
			}
			// A different size is proof of different content, and costs no read.
			if (entry.size !== undefined && entry.size !== file.stat.size) {
				conflicting.push(path);
				continue;
			}
			shared.push({ path, file, sha: entry.sha, size: entry.size });
		}

		for (const [path, entry] of remote.entries) {
			if (entry.type !== 'blob') continue;
			if (!matchesExtensions(path, extensions)) continue;
			if (isIgnoredPath(path, this.settings.ignoredPaths)) continue;
			if (!local.has(path)) remoteOnly.push(path);
		}

		// Announced before any reading starts, so the caller can warn that a
		// large comparison is about to take a while rather than looking stuck.
		const totalBytes = shared.reduce((sum, item) => sum + item.file.stat.size, 0);

		let done = 0;
		for (const item of shared) {
			onProgress?.({ done, total: shared.length, path: item.path, totalBytes });
			const bytes = await this.vault.readBinary(item.file);
			bytesHashed += bytes.byteLength;
			if ((await gitBlobSha(bytes)) !== item.sha) {
				conflicting.push(item.path);
			} else {
				identical[item.path] = { remoteSha: item.sha, localHash: await sha256(bytes) };
			}
			done++;
		}
		onProgress?.({ done, total: shared.length, path: '', totalBytes });

		return {
			relation: relationOf(remote, localOnly, remoteOnly, conflicting),
			commitSha: remote.commitSha,
			localOnly,
			remoteOnly,
			conflicting,
			identical,
			localCount: local.size,
			remoteCount: remote.entries.size,
			bytesHashed,
		};
	}
}

function relationOf(
	remote: RemoteSnapshot,
	localOnly: string[],
	remoteOnly: string[],
	conflicting: string[],
): SetupRelation {
	if (conflicting.length) return 'diverged';
	if (!remote.entries.size) return 'remote-empty';
	if (!localOnly.length && !remoteOnly.length) return 'up-to-date';
	if (!localOnly.length) return 'remote-ahead';
	if (!remoteOnly.length) return 'local-ahead';
	return 'both-ahead';
}
