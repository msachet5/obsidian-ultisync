import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { cleanupManagerBundle, managers } from './load-managers.mjs';
import { deferred, makeApp, MockVault } from './mock-vault.ts';

const { PullManager, SyncManager, TFile } = managers as {
	PullManager: new (...args: any[]) => any;
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

function entry(path: string, content: string) {
	return {
		path,
		mode: '100644',
		type: 'blob',
		sha: gitBlobSha(content),
		size: bytes(content).byteLength,
	};
}

function snapshot(...entries: ReturnType<typeof entry>[]) {
	return {
		commitSha: 'remote-head',
		treeSha: 'remote-tree',
		entries: new Map(entries.map((item) => [item.path, item])),
	};
}

function blob(text: string) {
	return {
		sha: gitBlobSha(text),
		content: Buffer.from(bytes(text)).toString('base64'),
		encoding: 'base64',
		size: bytes(text).byteLength,
	};
}

function settings(overrides: Record<string, unknown> = {}) {
	return {
		syncEnabled: true,
		githubOwner: 'owner',
		githubRepo: 'repo',
		branch: 'main',
		token: 'test-token',
		pullExtensions: ['.md', '.png'],
		pushExtensions: ['.md', '.png'],
		ignoredPaths: [],
		...overrides,
	};
}

function state() {
	return {
		deviceId: 'test-device',
		lastSyncedCommit: 'old-head',
		lastRemoteCheck: null,
		lastSuccessfulPull: null,
		lastSuccessfulPush: null,
		trackedFiles: {} as Record<string, any>,
		conflicts: {} as Record<string, any>,
		lastSyncedTree: {} as Record<string, string>,
		pendingRenames: {},
		debugLog: [],
	};
}

function track(stateValue: ReturnType<typeof state>, path: string, file: any, content: string) {
	stateValue.trackedFiles[path] = {
		localHash: sha256(content),
		remoteSha: gitBlobSha(content),
		mtime: file.stat.mtime,
		size: file.stat.size,
	};
	stateValue.lastSyncedTree[path] = gitBlobSha(content);
}

function githubFor(remote: ReturnType<typeof snapshot>, blobs: Record<string, string>) {
	return {
		getCommit: async (sha: string) => ({ sha, tree: { sha: remote.treeSha } }),
		readTreeSnapshot: async () => remote,
		getBlob: async (sha: string) => {
			const content = Object.values(blobs).find((value) => gitBlobSha(value) === sha);
			if (content === undefined) throw new Error(`Unknown mock blob: ${sha}`);
			return blob(content);
		},
	};
}

function pullSettings(overrides: Record<string, unknown> = {}) {
	return settings(overrides);
}

function pullManager(vault: MockVault, github: object, overrides: Record<string, unknown> = {}) {
	return new PullManager(makeApp(vault), github, pullSettings(overrides));
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

describe('remote pull safety', () => {
	it('keeps an edit made during download, advances the remote head, and saves a recoverable copy', async () => {
		setWindowForSyncManager();
		const vault = new MockVault(TFile);
		const file = vault.addFile('note.md', 'base');
		const current = state();
		track(current, 'note.md', file, 'base');
		const remote = snapshot(entry('note.md', 'remote version'));
		const requestStarted = deferred<void>();
		const resumeDownload = deferred<void>();
		const github = {
			...githubFor(remote, { note: 'remote version' }),
			getBlob: async () => {
				requestStarted.resolve();
				await resumeDownload.promise;
				return blob('remote version');
			},
		};
		const saves: unknown[] = [];
		const store = { save: async (value: unknown) => saves.push(value) };
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

		const reconcile = internal.reconcileRemoteAndLocal(
			'remote-head',
			github,
			true,
			'ahead',
		);
		const reachedDownload = await Promise.race([
			requestStarted.promise.then(() => true),
			reconcile.then(() => false),
		]);
		assert.equal(reachedDownload, true, 'the pull should pause while fetching the blob');
		vault.setText(file, 'my edit during download');
		resumeDownload.resolve();
		await reconcile;

		assert.equal(vault.getText(file), 'my edit during download');
		assert.equal(vault.getText(vault.getAbstractFileByPath('note (conflict - test-device).md') as any), 'remote version');
		assert.equal(current.conflicts['note.md']?.conflictCopyPath, 'note (conflict - test-device).md');
		assert.deepEqual(current.trackedFiles['note.md'], {
			localHash: sha256('base'),
			remoteSha: gitBlobSha('base'),
			mtime: 1,
			size: bytes('base').byteLength,
		});
		assert.equal(current.lastSyncedCommit, 'remote-head');
		assert.equal(current.lastSyncedTree['note.md'], gitBlobSha('remote version'));
		assert.ok(saves.length > 0);
	});

	it('checks text again inside Vault.process after the final preflight', async () => {
		const vault = new MockVault(TFile);
		const file = vault.addFile('atomic.md', 'base text');
		const current = state();
		track(current, 'atomic.md', file, 'base text');
		const remote = snapshot(entry('atomic.md', 'remote text'));
		const callbackEntered = deferred<void>();
		const resumeCallback = deferred<void>();
		vault.beforeProcessCallback = async () => {
			callbackEntered.resolve();
			await resumeCallback.promise;
		};
		const manager = pullManager(vault, githubFor(remote, { atomic: 'remote text' }));
		const apply = manager.applyRemoteChanges(remote, current, ['atomic.md'], []);

		const reachedCallback = await Promise.race([
			callbackEntered.promise.then(() => true),
			apply.then(() => false),
		]);
		assert.equal(reachedCallback, true, 'text replacement should enter Vault.process');
		vault.setText(file, 'late user edit');
		resumeCallback.resolve();
		const result = await apply;

		assert.equal(vault.getText(file), 'late user edit');
		assert.equal(result.pulled, 0);
		assert.ok(result.conflicts.some((conflict: any) => conflict.path === 'atomic.md'));
		assert.equal(current.trackedFiles['atomic.md'].localHash, sha256('base text'));
	});

	it('updates a pulled-only Markdown file and records its content hashes', async () => {
		const vault = new MockVault(TFile);
		const file = vault.addFile('readme.md', 'old text');
		const current = state();
		track(current, 'readme.md', file, 'old text');
		const remote = snapshot(entry('readme.md', 'new text from GitHub'));
		const manager = pullManager(
			vault,
			githubFor(remote, { readme: 'new text from GitHub' }),
			{ pullExtensions: ['.md'], pushExtensions: ['.png'] },
		);

		const result = await manager.applyRemoteChanges(remote, current, ['readme.md'], []);

		assert.equal(result.pulled, 1);
		assert.equal(vault.getText(file), 'new text from GitHub');
		assert.equal(current.trackedFiles['readme.md'].localHash, sha256('new text from GitHub'));
		assert.equal(current.trackedFiles['readme.md'].remoteSha, gitBlobSha('new text from GitHub'));
		assert.deepEqual(current.trackedFiles['readme.md'], {
			localHash: sha256('new text from GitHub'),
			remoteSha: gitBlobSha('new text from GitHub'),
		});
		assert.equal(file.stat.size, bytes('new text from GitHub').byteLength);
	});

	it('keeps a local edit to a remotely deleted file while another blob downloads', async () => {
		const vault = new MockVault(TFile);
		const deletedFile = vault.addFile('keep.md', 'base content');
		const current = state();
		track(current, 'keep.md', deletedFile, 'base content');
		const remote = snapshot(entry('other.md', 'new remote note'));
		const requestStarted = deferred<void>();
		const resumeDownload = deferred<void>();
		const github = {
			getBlob: async () => {
				requestStarted.resolve();
				await resumeDownload.promise;
				return blob('new remote note');
			},
		};
		const manager = pullManager(vault, github);
		const apply = manager.applyRemoteChanges(remote, current, ['other.md'], ['keep.md']);

		await requestStarted.promise;
		vault.setText(deletedFile, 'edit made before deletion');
		resumeDownload.resolve();
		const result = await apply;

		assert.equal(vault.getText(deletedFile), 'edit made before deletion');
		assert.equal(result.deletedPaths.has('keep.md'), false);
		assert.ok(result.conflicts.some((conflict: any) => conflict.path === 'keep.md'));
		assert.ok(current.trackedFiles['keep.md']);
	});

	it('keeps a new same-path file created while GitHub downloads it', async () => {
		const vault = new MockVault(TFile);
		const current = state();
		const remote = snapshot(entry('draft.md', 'remote draft'));
		const requestStarted = deferred<void>();
		const resumeDownload = deferred<void>();
		const github = {
			getBlob: async () => {
				requestStarted.resolve();
				await resumeDownload.promise;
				return blob('remote draft');
			},
		};
		const manager = pullManager(vault, github);
		const apply = manager.applyRemoteChanges(remote, current, ['draft.md'], []);

		await requestStarted.promise;
		const userFile = vault.addFile('draft.md', 'my new draft');
		resumeDownload.resolve();
		const result = await apply;

		assert.equal(vault.getText(userFile), 'my new draft');
		assert.equal(vault.pluginWrites, 0);
		assert.equal(result.pulled, 0);
		assert.ok(result.conflicts.some((conflict: any) => conflict.path === 'draft.md'));
	});

	it('keeps a same-path file created during the initial pull download', async () => {
		const vault = new MockVault(TFile);
		const current = state();
		const remote = snapshot(entry('first.md', 'remote first note'));
		const requestStarted = deferred<void>();
		const resumeDownload = deferred<void>();
		const manager = pullManager(vault, {
			getBlob: async () => {
				requestStarted.resolve();
				await resumeDownload.promise;
				return blob('remote first note');
			},
		});
		const initialPull = manager.performInitialPull(remote, current);

		await requestStarted.promise;
		const userFile = vault.addFile('first.md', 'user first note');
		resumeDownload.resolve();
		const result = await initialPull;

		assert.equal(vault.getText(userFile), 'user first note');
		assert.equal(result.pulled, 0);
		assert.ok(result.conflicts.some((conflict: any) => conflict.path === 'first.md'));
		assert.equal(current.trackedFiles['first.md'], undefined);
	});

	it('keeps a file that appears after the absent-path check and before createBinary commits', async () => {
		const vault = new MockVault(TFile);
		const current = state();
		const remote = snapshot(entry('nested/new.md', 'remote new note'));
		const createStarted = deferred<void>();
		const resumeCreate = deferred<void>();
		vault.beforeCreateBinary = async () => {
			createStarted.resolve();
			await resumeCreate.promise;
		};
		const manager = pullManager(vault, githubFor(remote, { newNote: 'remote new note' }));
		const apply = manager.applyRemoteChanges(remote, current, ['nested/new.md'], []);

		await createStarted.promise;
		const userFile = vault.addFile('nested/new.md', 'user new note');
		resumeCreate.resolve();
		const result = await apply;

		assert.equal(vault.getText(userFile), 'user new note');
		assert.equal(result.pulled, 0);
		assert.ok(result.conflicts.some((conflict: any) => conflict.path === 'nested/new.md'));
		assert.equal(vault.pluginWrites, 0);
	});

	it('does not write or report a conflict when local bytes already match GitHub', async () => {
		const vault = new MockVault(TFile);
		const file = vault.addFile('same.md', 'converged text');
		const current = state();
		track(current, 'same.md', file, 'older text');
		const remote = snapshot(entry('same.md', 'converged text'));
		const manager = pullManager(vault, githubFor(remote, { same: 'converged text' }));
		const originalStat = { ...file.stat };

		const result = await manager.applyRemoteChanges(remote, current, ['same.md'], []);

		assert.equal(vault.pluginWrites, 0);
		assert.equal(result.pulled, 0);
		assert.deepEqual(result.conflicts, []);
		assert.equal(vault.getText(file), 'converged text');
		assert.deepEqual(file.stat, originalStat);
		assert.equal(current.trackedFiles['same.md'].localHash, sha256('converged text'));
		assert.equal(current.trackedFiles['same.md'].remoteSha, gitBlobSha('converged text'));
	});

	it('updates a clean binary file when it still matches the tracked version', async () => {
		const vault = new MockVault(TFile);
		const file = vault.addFile('asset.png', 'local bytes');
		const current = state();
		track(current, 'asset.png', file, 'local bytes');
		const remote = snapshot(entry('asset.png', 'remote bytes'));
		const manager = pullManager(vault, githubFor(remote, { asset: 'remote bytes' }));

		const result = await manager.applyRemoteChanges(remote, current, ['asset.png'], []);

		assert.equal(vault.getText(file), 'remote bytes');
		assert.equal(result.pulled, 1);
		assert.deepEqual(result.conflicts, []);
	});

	it('keeps a binary edit made during download and reports a conflict', async () => {
		const vault = new MockVault(TFile);
		const file = vault.addFile('asset.png', 'local bytes');
		const current = state();
		track(current, 'asset.png', file, 'local bytes');
		const remote = snapshot(entry('asset.png', 'remote bytes'));
		const requestStarted = deferred<void>();
		const resumeDownload = deferred<void>();
		const manager = pullManager(vault, {
			getBlob: async () => {
				requestStarted.resolve();
				await resumeDownload.promise;
				return blob('remote bytes');
			},
		});
		const apply = manager.applyRemoteChanges(remote, current, ['asset.png'], []);

		await requestStarted.promise;
		vault.setText(file, 'my binary edit during download');
		resumeDownload.resolve();
		const result = await apply;

		assert.equal(vault.getText(file), 'my binary edit during download');
		assert.equal(file.path, 'asset.png');
		assert.equal(result.pulled, 0);
		assert.ok(result.conflicts.some((conflict: any) => conflict.path === 'asset.png'));
		assert.equal(current.trackedFiles['asset.png'].localHash, sha256('local bytes'));
	});

	it('deletes a clean remotely deleted file and clears its tracking record', async () => {
		const vault = new MockVault(TFile);
		const file = vault.addFile('gone.md', 'local baseline');
		const current = state();
		track(current, 'gone.md', file, 'local baseline');
		const remote = snapshot();
		const manager = pullManager(vault, { getBlob: async () => { throw new Error('no blob expected'); } });

		const result = await manager.applyRemoteChanges(remote, current, [], ['gone.md']);

		assert.equal(vault.getAbstractFileByPath('gone.md'), null);
		assert.deepEqual([...result.deletedPaths], ['gone.md']);
		assert.equal(current.trackedFiles['gone.md'], undefined);
		assert.deepEqual(result.conflicts, []);
	});

	it('applies an explicit binary choice after checking its captured hash', async () => {
		const vault = new MockVault(TFile);
		const file = vault.addFile('asset.png', 'chosen local bytes');
		const current = state();
		track(current, 'asset.png', file, 'chosen local bytes');
		const remote = snapshot(entry('asset.png', 'chosen remote bytes'));
		const manager = pullManager(vault, githubFor(remote, { asset: 'chosen remote bytes' }));

		const result = await manager.applyRemoteChanges(
			remote,
			current,
			['asset.png'],
			[],
			new Map([['asset.png', sha256('chosen local bytes')]]),
		);

		assert.equal(vault.getText(file), 'chosen remote bytes');
		assert.equal(result.pulled, 1);
		assert.deepEqual(result.conflicts, []);
	});

	it('reports a folder collision and leaves the folder in place', async () => {
		const vault = new MockVault(TFile);
		vault.addFolder('collision.md');
		const current = state();
		const remote = snapshot(entry('collision.md', 'remote note'));
		const manager = pullManager(vault, githubFor(remote, { collision: 'remote note' }));

		const result = await manager.applyRemoteChanges(remote, current, ['collision.md'], []);

		assert.equal(result.pulled, 0);
		assert.ok(result.conflicts.some((conflict: any) => conflict.path === 'collision.md'));
		assert.equal((vault.getAbstractFileByPath('collision.md') as any).kind, 'folder');
		assert.equal(vault.pluginWrites, 0);
	});

});
