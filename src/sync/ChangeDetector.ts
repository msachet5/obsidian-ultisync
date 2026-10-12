import { TFile, Vault } from 'obsidian';
import { RemoteSnapshot } from '../github/GitHubClient';
import { UltiSyncSettings, NEW_FILE_SETTLE_MS, SyncStateData } from '../types';
import { isIgnoredPath, matchesExtensions, normalizePath } from '../vault/PathFilter';
import { sha256 } from '../vault/VaultScanner';

export interface LocalChanges {
	modifiedOrCreated: Set<string>;
	deleted: Set<string>;
	/** Paths held back until the timestamp, keyed by path. */
	deferred: Map<string, number>;
}

export interface RemoteChanges {
	changedOrCreated: Set<string>;
	deleted: Set<string>;
}

export class ChangeDetector {
	constructor(
		private vault: Vault,
		private settings: UltiSyncSettings,
	) {}

	async detectLocalChanges(
		state: SyncStateData,
		extensions: string[],
		userNamed: Set<string> = new Set(),
	): Promise<LocalChanges> {
		const eligible = new Map<string, TFile>();
		for (const file of this.vault.getFiles()) {
			const path = normalizePath(file.path);
			if (
				matchesExtensions(path, extensions) &&
				!isIgnoredPath(path, this.settings.ignoredPaths)
			) {
				eligible.set(path, file);
			}
		}

		const modifiedOrCreated = new Set<string>();
		const deleted = new Set<string>();
		const deferred = new Map<string, number>();

		for (const [path, file] of eligible) {
			const tracked = state.trackedFiles[path];

			if (!tracked) {
				// Obsidian creates a note as an empty file and names it a moment
				// later. Pushing at that instant would commit an empty blob under a
				// placeholder name, so a brand new empty file waits, unless the user
				// named it themselves.
				const settledAt = file.stat.ctime + NEW_FILE_SETTLE_MS;
				if (!userNamed.has(path) && file.stat.size === 0 && Date.now() < settledAt) {
					deferred.set(path, settledAt);
					continue;
				}
				modifiedOrCreated.add(path);
				continue;
			}

			// Fast path: an untouched mtime and size mean the content cannot have
			// changed, so the file is never read.
			if (
				tracked.mtime !== undefined &&
				tracked.size !== undefined &&
				file.stat.mtime === tracked.mtime &&
				file.stat.size === tracked.size
			) {
				continue;
			}

			const stat = { mtime: file.stat.mtime, size: file.stat.size };
			const hash = await sha256(await this.vault.readBinary(file));
			if (hash !== tracked.localHash) {
				modifiedOrCreated.add(path);
				continue;
			}

			// Same content, new stat. Record it so the fast path applies next time.
			tracked.mtime = stat.mtime;
			tracked.size = stat.size;
		}

		for (const path of Object.keys(state.trackedFiles)) {
			if (!matchesExtensions(path, extensions)) continue;
			if (isIgnoredPath(path, this.settings.ignoredPaths)) continue;
			if (!eligible.has(path)) {
				deleted.add(path);
			}
		}

		return { modifiedOrCreated, deleted, deferred };
	}

	detectRemoteChanges(
		state: SyncStateData,
		remote: RemoteSnapshot,
		extensions: string[],
	): RemoteChanges {
		const changedOrCreated = new Set<string>();
		const deleted = new Set<string>();

		for (const [path, tracked] of Object.entries(state.trackedFiles)) {
			if (!matchesExtensions(path, extensions)) continue;
			if (isIgnoredPath(path, this.settings.ignoredPaths)) continue;

			const remoteEntry = remote.entries.get(path);
			if (!remoteEntry || remoteEntry.type !== 'blob') {
				if (tracked.remoteSha !== null) {
					deleted.add(path);
				}
				continue;
			}
			if (remoteEntry.sha !== tracked.remoteSha) {
				changedOrCreated.add(path);
			}
		}

		for (const [path, remoteEntry] of remote.entries) {
			if (!matchesExtensions(path, extensions)) continue;
			if (isIgnoredPath(path, this.settings.ignoredPaths)) continue;
			if (remoteEntry.type !== 'blob') continue;
			if (!state.trackedFiles[path]) {
				changedOrCreated.add(path);
			}
		}

		return { changedOrCreated, deleted };
	}
}
