import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { cleanupManagerBundle, managers } from './load-managers.mjs';
import { makeApp, MockVault } from './mock-vault.ts';

const { ChangeDetector, SyncManager, TFile } = managers as {
	ChangeDetector: new (...args: any[]) => any;
	SyncManager: new (...args: any[]) => any;
	TFile: new (path: string, bytes?: Uint8Array) => object;
};

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
	return encoder.encode(text);
}

function sha256(text: string): string {
	return createHash('sha256').update(bytes(text)).digest('hex');
}

function gitBlobSha(text: string): string {
	const content = bytes(text);
	return createHash('sha1')
		.update(Buffer.from(`blob ${content.byteLength}\0`))
		.update(content)
		.digest('hex');
}

function remoteSnapshot(path: string, text: string) {
	return {
		commitSha: 'head-new',
		treeSha: 'tree-new',
		entries: new Map([
			[
				path,
				{
					path,
					mode: '100644',
					type: 'blob',
					sha: gitBlobSha(text),
					size: bytes(text).byteLength,
				},
			],
		]),
	};
}

function settings() {
	return {
		syncEnabled: true,
		githubOwner: 'owner',
		githubRepo: 'repo',
		branch: 'main',
		token: 'test-token',
		pullExtensions: ['.md'],
		pushExtensions: ['.md'],
		ignoredPaths: [],
	};
}

function makeState(file: any, path: string, localText: string) {
	return {
		deviceId: 'test-device',
		lastSyncedCommit: 'head-old',
		lastRemoteCheck: null,
		lastSuccessfulPull: null,
		lastSuccessfulPush: null,
		trackedFiles: {
			[path]: {
				localHash: sha256(localText),
				remoteSha: gitBlobSha(localText),
				mtime: file.stat.mtime,
				size: file.stat.size,
			},
		},
		conflicts: {},
		lastSyncedTree: { [path]: gitBlobSha(localText) },
		pendingRenames: {},
		debugLog: [],
	};
}

function setWindowForSyncManager(): void {
	if (typeof globalThis.window !== 'undefined') return;
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: {
			setTimeout: globalThis.setTimeout.bind(globalThis),
			clearTimeout: globalThis.clearTimeout.bind(globalThis),
			setInterval: globalThis.setInterval.bind(globalThis),
			clearInterval: globalThis.clearInterval.bind(globalThis),
		},
	});
}

after(async () => {
	await cleanupManagerBundle();
});

describe('SyncManager reconciliation tracking', () => {
	it('records pulled content without stale stats and detects a same-stat local edit', async () => {
		setWindowForSyncManager();
		const vault = new MockVault(TFile);
		const file = vault.addFile('note.md', 'old text');
		const current = makeState(file, 'note.md', 'old text');
		const remote = remoteSnapshot('note.md', 'new text');
		const github = {
			getCommit: async (sha: string) => ({ sha, tree: { sha: remote.treeSha } }),
			readTreeSnapshot: async () => remote,
			getBlob: async () => ({
				sha: gitBlobSha('new text'),
				content: Buffer.from(bytes('new text')).toString('base64'),
				encoding: 'base64',
				size: bytes('new text').byteLength,
			}),
		};
		const store = { save: async () => undefined };
		const manager = new SyncManager(
			makeApp(vault),
			settings(),
			store,
			current,
			() => undefined,
			() => undefined,
		);
		const internal = manager as unknown as {
			getClient: () => object;
			reconcileRemoteAndLocal: (
				head: string,
				client: object,
				allowDeletions?: boolean,
				relation?: string,
				renames?: Map<string, string>,
			) => Promise<void>;
		};
		internal.getClient = () => github;

		await internal.reconcileRemoteAndLocal('head-new', github, true, 'ahead');

		assert.equal(vault.getText(file), 'new text');
		assert.equal(current.lastSyncedCommit, 'head-new');
		assert.deepEqual(current.trackedFiles['note.md'], {
			localHash: sha256('new text'),
			remoteSha: gitBlobSha('new text'),
		});
		assert.deepEqual(current.lastSyncedTree, { 'note.md': gitBlobSha('new text') });

		// The filesystem can keep the same timestamp and size for a quick edit.
		// With no cached stat pair, the detector reads the bytes and sees it.
		vault.setTextAtSameStat(file, 'usr edit');
		const detector = new ChangeDetector(vault, settings());
		const local = await detector.detectLocalChanges(current, ['.md']);
		assert.deepEqual([...local.modifiedOrCreated], ['note.md']);

		manager.destroy();
	});
});
