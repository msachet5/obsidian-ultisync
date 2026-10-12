import { App, Platform, TFile, Vault } from 'obsidian';
import { GitHubClient, RemoteSnapshot } from '../github/GitHubClient';
import { UltiSyncSettings, SyncStateData, ConflictRecord } from '../types';
import {
	isIgnoredPath,
	isSafeVaultPath,
	isWritableOnThisPlatform,
	matchesExtensions,
	normalizePath,
} from '../vault/PathFilter';
import { base64ToArrayBuffer, sha256 } from '../vault/VaultScanner';
import { guardedTextWrite, LocalFileChangedError, losslessText } from '../vault/GuardedWrite';

export interface ApplyResult {
	pulled: number;
	deletedPaths: Set<string>;
	trace: string[];
	conflicts: ConflictRecord[];
	appliedPaths: Set<string>;
}

/** Blobs per round of downloads. Small enough that a large pull never holds
 *  every decoded file in memory at once. */
const BATCH_SIZE = 4;

export class PullManager {
	constructor(
		private app: App,
		private github: GitHubClient,
		private settings: UltiSyncSettings,
		/** Called as each file lands, so a long pull can say where it is. The
		 *  byte total is what decides whether it is worth saying at all. */
		private onProgress: (done: number, total: number, totalBytes: number) => void = () =>
			undefined,
		/**
		 * Called with a path immediately before this manager writes, moves or
		 * trashes it. The vault event that follows must be recognised as the
		 * plugin's own, and a mark made at the start of a long pull has lapsed
		 * by the time the hundredth file lands.
		 */
		private onBeforeWrite: (path: string) => void = () => undefined,
	) {}

	private get vault(): Vault {
		return this.app.vault;
	}

	// Every deletion in the plugin goes through here. FileManager.trashFile
	// follows the vault's own "Deleted files" preference, so a file this plugin
	// removes ends up wherever Obsidian would have put it.
	private async trash(file: TFile): Promise<void> {
		this.onBeforeWrite(file.path);
		await this.app.fileManager.trashFile(file);
	}

	async applyRemoteChanges(
		remote: RemoteSnapshot,
		state: SyncStateData,
		safeChangedPaths: Iterable<string>,
		safeDeletedPaths: Iterable<string>,
		/** Capture explicit conflict choices before network or confirmation waits. */
		expectedHashes?: Map<string, string | null>,
	): Promise<ApplyResult> {
		const deletedPaths = new Set<string>();
		const trace: string[] = [];
		const conflicts: ConflictRecord[] = [];
		const appliedPaths = new Set<string>();

		const changed = [...safeChangedPaths].filter((path) => this.isPullable(path, remote));
		const pulled = await this.downloadAndWrite(changed, remote, state, conflicts, expectedHashes, appliedPaths);

		for (const path of safeDeletedPaths) {
			if (!matchesExtensions(path, this.settings.pullExtensions)) {
				trace.push(`${path}: skipped, extension not in pullExtensions`);
				continue;
			}
			if (isIgnoredPath(path, this.settings.ignoredPaths)) {
				trace.push(`${path}: skipped, ignoredPaths`);
				continue;
			}

			const file = this.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				const stat = { mtime: file.stat.mtime, size: file.stat.size };
				const hash = await sha256(await this.vault.readBinary(file));
				const expectedHash = expectedHashes?.has(path)
					? expectedHashes.get(path) : state.trackedFiles[path]?.localHash;
				if (expectedHash !== hash) {
					conflicts.push(this.conflict(path, hash, remote));
					trace.push(`${path}: kept locally, content changed before deletion`);
					continue;
				}
				if (this.vault.getAbstractFileByPath(path) !== file || file.path !== path ||
					file.stat.mtime !== stat.mtime || file.stat.size !== stat.size) {
					conflicts.push(this.conflict(path, hash, remote));
					continue;
				}
				await this.trash(file);
				trace.push(`${path}: found locally, moved to trash`);
			} else {
				trace.push(
					`${path}: NOT found locally (getAbstractFileByPath returned ${
						file === null ? 'null' : typeof file
					}) — nothing to trash, only bookkeeping cleared`,
				);
			}
			delete state.trackedFiles[path];
			deletedPaths.add(path);
		}

		return { pulled, deletedPaths, trace, conflicts, appliedPaths };
	}

	/**
	 * @param overwriteExisting - Set after a reset, which has just cleared the
	 * vault on purpose. The collision guard below exists to protect a vault that
	 * already holds work from a first-time pull, and applying it to a reset
	 * turns a file that resisted deletion into a reason to abandon the whole
	 * operation.
	 */
	async performInitialPull(
		remote: RemoteSnapshot,
		state: SyncStateData,
		overwriteExisting = false,
	): Promise<{ pulled: number; skipped: number; conflicts: ConflictRecord[] }> {
		if (this.settings.pullExtensions.length === 0) {
			throw new Error('Select at least one pull extension before the initial pull.');
		}

		const paths = Array.from(remote.entries.keys()).filter((path) => {
			const entry = remote.entries.get(path);
			return Boolean(
				entry &&
					entry.type === 'blob' &&
					matchesExtensions(path, this.settings.pullExtensions) &&
					!isIgnoredPath(path, this.settings.ignoredPaths) &&
					isSafeVaultPath(path),
			);
		});

		const collisions = overwriteExisting
			? []
			: paths.filter((path) => this.vault.getAbstractFileByPath(path));
		if (collisions.length) {
			const SHOWN = 25;
			const list = collisions
				.slice(0, SHOWN)
				.map((path) => `  • ${path}`)
				.join('\n');
			const more =
				collisions.length > SHOWN ? `\n  ...and ${collisions.length - SHOWN} more` : '';
			throw new Error(
				`Initial pull would overwrite ${collisions.length} existing local file(s). ` +
					`Remove them (or the whole vault's content) first, then retry:\n` +
					list +
					more,
			);
		}

		const conflicts: ConflictRecord[] = [];
		const expectedHashes = new Map<string, string | null>();
		for (const path of paths) {
			const file = this.vault.getAbstractFileByPath(path);
			expectedHashes.set(path, overwriteExisting && file instanceof TFile
				? await sha256(await this.vault.readBinary(file)) : null);
		}
		const pulled = await this.downloadAndWrite(paths, remote, state, conflicts, expectedHashes);
		// Everything in the repository the extension filters exclude. Reported so
		// a repository that is mostly unsupported file types does not look like a
		// pull that quietly failed.
		return { pulled, skipped: remote.entries.size - paths.length, conflicts };
	}

	// Blobs are fetched a batch at a time rather than strictly one after another.
	// Each download is a separate round trip, and on a phone the serial version
	// spends nearly all of its time waiting.
	private async downloadAndWrite(
		paths: string[],
		remote: RemoteSnapshot,
		state: SyncStateData,
		conflicts: ConflictRecord[],
		expectedHashes?: Map<string, string | null>,
		appliedPaths: Set<string> = new Set(),
	): Promise<number> {
		let pulled = 0;
		const totalBytes = paths.reduce(
			(sum, path) => sum + (remote.entries.get(path)?.size ?? 0),
			0,
		);
		// Announced before the first request so the count appears immediately,
		// rather than after the first batch has already come down.
		this.onProgress(0, paths.length, totalBytes);

		for (let index = 0; index < paths.length; index += BATCH_SIZE) {
			const batch = paths.slice(index, index + BATCH_SIZE);
			const fetched = await Promise.all(
				batch.map(async (path) => {
					const entry = remote.entries.get(path);
					if (!entry?.sha) return null;
					const blob = await this.github.getBlob(entry.sha);
					return {
						path,
						sha: entry.sha,
						bytes: base64ToArrayBuffer(blob.content),
					};
				}),
			);

			for (const item of fetched) {
				if (!item) continue;
				const expectedHash = expectedHashes?.has(item.path)
					? expectedHashes.get(item.path) ?? null
					: state.trackedFiles[item.path]?.localHash ?? null;
				let wrote: boolean;
				try {
					wrote = await this.writeBinaryFile(item.path, item.bytes, expectedHash);
				} catch (error) {
					if (!(error instanceof LocalFileChangedError)) throw error;
					const file = this.vault.getAbstractFileByPath(item.path);
					const hash = file instanceof TFile
						? await sha256(await this.vault.readBinary(file)) : null;
					conflicts.push(this.conflict(item.path, hash, remote));
					continue;
				}
				state.trackedFiles[item.path] = {
					localHash: await sha256(item.bytes),
					remoteSha: item.sha,
				};
				appliedPaths.add(item.path);
				if (wrote) pulled++;
				this.onProgress(pulled, paths.length, totalBytes);
			}
		}

		return pulled;
	}

	private isPullable(path: string, remote: RemoteSnapshot): boolean {
		const entry = remote.entries.get(path);
		return Boolean(
			entry &&
				entry.type === 'blob' &&
				entry.sha &&
				matchesExtensions(path, this.settings.pullExtensions) &&
				!isIgnoredPath(path, this.settings.ignoredPaths) &&
				isSafeVaultPath(path) &&
				isWritableOnThisPlatform(path, Platform.isWin),
		);
	}

	/** Remote paths this platform cannot represent, so they can be reported. */
	unwritablePaths(remote: RemoteSnapshot): string[] {
		return Array.from(remote.entries.keys()).filter(
			(path) => !isWritableOnThisPlatform(path, Platform.isWin),
		);
	}

	private conflict(path: string, localHash: string | null, remote: RemoteSnapshot): ConflictRecord {
		const entry = remote.entries.get(path);
		return {
			path,
			detectedAt: new Date().toISOString(),
			localHash,
			remoteSha: entry?.sha ?? null,
			remoteExists: entry?.type === 'blob',
			conflictCopyPath: null,
		};
	}

	private async writeBinaryFile(
		path: string,
		bytes: ArrayBuffer,
		expectedHash: string | null,
	): Promise<boolean> {
		const normalized = normalizePath(path);
		const remoteHash = await sha256(bytes);
		await this.ensureParentFolder(normalized);

		const existing = this.vault.getAbstractFileByPath(normalized);
		if (existing instanceof TFile) {
			const stat = { mtime: existing.stat.mtime, size: existing.stat.size };
			const current = await this.vault.readBinary(existing);
			const hash = await sha256(current);
			if (this.vault.getAbstractFileByPath(normalized) !== existing || existing.path !== normalized ||
				existing.stat.mtime !== stat.mtime || existing.stat.size !== stat.size) {
				throw new LocalFileChangedError(normalized);
			}
			if (hash === remoteHash) return false;
			if (hash !== expectedHash) throw new LocalFileChangedError(normalized);
			const text = /\.(md|canvas|base|svg)$/i.test(normalized) ? losslessText(bytes) : null;
			if (text !== null && losslessText(current) !== null) {
				await guardedTextWrite(this.vault, existing, current, text,
					() => this.onBeforeWrite(normalized));
				return true;
			}
			// Binary writes lack process()'s atomic check. The content check above
			// protects edits made during download, but the API call can still wait.
			this.onBeforeWrite(normalized);
			await this.vault.modifyBinary(existing, bytes);
			return true;
		}
		if (existing) {
			throw new LocalFileChangedError(normalized);
		}
		// A locally deleted tracked file must stay deleted until resolved.
		if (expectedHash !== null) throw new LocalFileChangedError(normalized);
		this.onBeforeWrite(normalized);
		try {
			await this.vault.createBinary(normalized, bytes);
		} catch (error) {
			// createBinary refuses an existing path. A creation queued behind
			// ours must never turn into modifyBinary on retry.
			if (this.vault.getAbstractFileByPath(normalized)) throw new LocalFileChangedError(normalized);
			throw error;
		}
		return true;
	}

	private async ensureParentFolder(path: string): Promise<void> {
		const parts = path.split('/');
		parts.pop();
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.vault.getAbstractFileByPath(current)) {
				await this.vault.createFolder(current);
			}
		}
	}
}
