import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { cleanupManagerBundle, managers } from './load-managers.mjs';
import { deferred, makeApp, MockVault } from './mock-vault.ts';

const { ChangeDetector, SyncManager, TFile } = managers as {
	ChangeDetector: new (...args: any[]) => any;
	SyncManager: new (...args: any[]) => any;
	TFile: new (path: string, bytes?: Uint8Array) => object;
};

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);
const sha256 = (text: string) => createHash('sha256').update(bytes(text)).digest('hex');
const gitBlobSha = (text: string) => {
	const content = bytes(text);
	return createHash('sha1')
		.update(Buffer.from(`blob ${content.byteLength}\0`))
		.update(content)
		.digest('hex');
};

function entry(path: string, text: string) {
	return {
		path,
		mode: '100644',
		type: 'blob',
		sha: gitBlobSha(text),
		size: bytes(text).byteLength,
	};
}

function snapshot(...entries: ReturnType<typeof entry>[]) {
	return {
		commitSha: 'head-new',
		treeSha: 'tree-new',
		entries: new Map(entries.map((item) => [item.path, item])),
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

function makeState() {
	return {
		deviceId: 'test-device',
		lastSyncedCommit: 'head-old',
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

function addConflict(
	state: ReturnType<typeof makeState>,
	path: string,
	localText: string | null,
	remoteText: string | null,
	copyPath: string | null = null,
): void {
	state.conflicts[path] = {
		path,
		detectedAt: new Date(0).toISOString(),
		localHash: localText === null ? null : sha256(localText),
		remoteSha: remoteText === null ? null : gitBlobSha(remoteText),
		remoteExists: remoteText !== null,
		conflictCopyPath: copyPath,
	};
}

function trackBaseline(state: ReturnType<typeof makeState>, path: string, text: string): void {
	state.trackedFiles[path] = {
		localHash: sha256(text),
		remoteSha: gitBlobSha(text),
		mtime: 1,
		size: bytes(text).byteLength,
	};
	state.lastSyncedTree[path] = gitBlobSha(text);
}

function makeManager(vault: MockVault, state: ReturnType<typeof makeState>, github: object, store = { save: async () => undefined }) {
	const manager = new SyncManager(
		makeApp(vault),
		settings(),
		store,
		state,
		() => undefined,
		() => undefined,
	);
	const runtime = manager as unknown as {
		getClient: () => object;
		debug: (line: string) => void;
		scheduleDebouncedPush: () => void;
	};
	runtime.getClient = () => github;
	runtime.debug = () => undefined;
	runtime.scheduleDebouncedPush = () => undefined;
	return manager;
}

after(async () => {
	await cleanupManagerBundle();
});

describe('conflict resolution safety', () => {
	it('pushes the chosen local file even when tracking says it is unchanged', async () => {
		const vault = new MockVault(TFile);
		const file = vault.addFile('note.md', 'my local version');
		const state = makeState();
		state.trackedFiles['note.md'] = {
			localHash: sha256('my local version'),
			remoteSha: gitBlobSha('my local version'),
			mtime: file.stat.mtime,
			size: file.stat.size,
		};
		state.lastSyncedTree['note.md'] = gitBlobSha('my local version');
		addConflict(state, 'note.md', 'my local version', null);

		let head = 'head-old';
		let pushed: { path: string; sha: string | null }[] = [];
		const emptyRemote = snapshot();
		const github = {
			getBranchReferenceOrNull: async () => ({ object: { sha: head } }),
			getBranchReference: async () => ({ object: { sha: head } }),
			invalidateBranchCache: () => undefined,
			isStaleHead: async () => false,
			getCommit: async (sha: string) => ({ sha, tree: { sha: 'tree-old' } }),
			readTreeSnapshot: async () => ({ ...emptyRemote, commitSha: head, treeSha: 'tree-old' }),
			createBlob: async (content: string) => {
				const text = Buffer.from(content, 'base64').toString('utf8');
				return { sha: gitBlobSha(text) };
			},
			createTree: async (_base: string, entries: { path: string; sha: string | null }[]) => {
				pushed = entries;
				return { sha: 'tree-pushed' };
			},
			createCommit: async () => ({ sha: 'head-pushed' }),
			updateReference: async () => {
				head = 'head-pushed';
			},
		};
		const manager = makeManager(vault, state, github);

		await manager.keepLocal('note.md');

		assert.equal(pushed.length, 1);
		assert.equal(pushed[0].path, 'note.md');
		assert.equal(pushed[0].sha, gitBlobSha('my local version'));
		assert.equal(state.trackedFiles['note.md'].remoteSha, gitBlobSha('my local version'));
		assert.equal(state.conflicts['note.md'], undefined);
		assert.equal(state.lastSyncedCommit, 'head-pushed');
		assert.equal(vault.getText(file), 'my local version');
	});

	it('keeps the chosen conflict when a different local path is the only file pushed', async () => {
		const vault = new MockVault(TFile);
		const chosenFile = vault.addFile('note.md', 'chosen local version');
		vault.addFile('note (conflict - test-device).md', 'remote version shown earlier');
		vault.addFile('other.md', 'other local edit');
		const state = makeState();
		trackBaseline(state, 'note.md', 'old note base');
		trackBaseline(state, 'note (conflict - test-device).md', 'remote version shown earlier');
		trackBaseline(state, 'other.md', 'other remote base');
		addConflict(
			state,
			'note.md',
			'chosen local version',
			'remote version shown earlier',
			'note (conflict - test-device).md',
		);
		const remote = {
			...snapshot(
				entry('note.md', 'newer remote version'),
				entry('note (conflict - test-device).md', 'remote version shown earlier'),
				entry('other.md', 'other remote base'),
			),
			commitSha: 'head-old',
			treeSha: 'tree-old',
		};
		const oldConflictCopy = state.conflicts['note.md'].conflictCopyPath;
		let head = 'head-old';
		let pushed: { path: string; sha: string | null }[] = [];
		const remoteBodies = new Map([
			[gitBlobSha('newer remote version'), 'newer remote version'],
			[gitBlobSha('remote version shown earlier'), 'remote version shown earlier'],
			[gitBlobSha('other remote base'), 'other remote base'],
		]);
		const github = {
			getBranchReferenceOrNull: async () => ({ object: { sha: head } }),
			getBranchReference: async () => ({ object: { sha: head } }),
			invalidateBranchCache: () => undefined,
			isStaleHead: async () => false,
			getCommit: async (sha: string) => ({ sha, tree: { sha: remote.treeSha } }),
			readTreeSnapshot: async () => ({ ...remote, commitSha: head }),
			getBlob: async (sha: string) => {
				const content = remoteBodies.get(sha);
				if (content === undefined) throw new Error(`Unknown remote blob: ${sha}`);
				return { content: Buffer.from(content).toString('base64') };
			},
			createBlob: async (content: string) => ({
				sha: gitBlobSha(Buffer.from(content, 'base64').toString('utf8')),
			}),
			createTree: async (_base: string, entries: { path: string; sha: string | null }[]) => {
				pushed = entries;
				return { sha: 'tree-pushed' };
			},
			createCommit: async () => ({ sha: 'head-pushed' }),
			updateReference: async () => {
				head = 'head-pushed';
			},
		};
		const manager = makeManager(vault, state, github);

		await manager.keepLocal('note.md');

		assert.equal(pushed.length, 1);
		assert.equal(pushed[0].path, 'other.md');
		assert.equal(pushed[0].sha, gitBlobSha('other local edit'));
		assert.equal(vault.getText(chosenFile), 'chosen local version');
		assert.equal(state.conflicts['note.md'].remoteSha, gitBlobSha('newer remote version'));
		assert.notEqual(state.conflicts['note.md'].conflictCopyPath, oldConflictCopy);
		assert.equal(
			vault.getText(vault.getAbstractFileByPath(state.conflicts['note.md'].conflictCopyPath) as any),
			'newer remote version',
		);
		assert.equal(state.lastSyncedTree['other.md'], gitBlobSha('other local edit'));
	});

	it('keeps the conflict when the chosen local push fails', async () => {
		const vault = new MockVault(TFile);
		vault.addFile('note.md', 'chosen local version');
		const state = makeState();
		trackBaseline(state, 'note.md', 'remote base');
		addConflict(state, 'note.md', 'chosen local version', 'remote base');
		const conflict = state.conflicts['note.md'];
		const remote = {
			...snapshot(entry('note.md', 'remote base')),
			commitSha: 'head-old',
			treeSha: 'tree-old',
		};
		const github = {
			getBranchReferenceOrNull: async () => ({ object: { sha: 'head-old' } }),
			getBranchReference: async () => ({ object: { sha: 'head-old' } }),
			invalidateBranchCache: () => undefined,
			isStaleHead: async () => false,
			getCommit: async (sha: string) => ({ sha, tree: { sha: remote.treeSha } }),
			readTreeSnapshot: async () => remote,
			createBlob: async () => ({ sha: gitBlobSha('chosen local version') }),
			createTree: async () => {
				throw new Error('temporary GitHub failure');
			},
		};
		const manager = makeManager(vault, state, github);

		await assert.rejects(manager.keepLocal('note.md'), /temporary GitHub failure/);

		assert.equal(state.conflicts['note.md'], conflict);
		assert.equal(state.lastSyncedCommit, 'head-old');
	});

	it('keeps a newer remote version when the conflict changed after the user chose it', async () => {
		const vault = new MockVault(TFile);
		const file = vault.addFile('note.md', 'my local version');
		vault.addFile('note (conflict - test-device).md', 'remote version shown earlier');
		const state = makeState();
		state.trackedFiles['note.md'] = {
			localHash: sha256('base'),
			remoteSha: gitBlobSha('base'),
			mtime: 1,
			size: 4,
		};
		state.lastSyncedTree['note.md'] = gitBlobSha('base');
		addConflict(
			state,
			'note.md',
			'my local version',
			'remote version shown earlier',
			'note (conflict - test-device).md',
		);
		const remote = snapshot(entry('note.md', 'newer remote version'));
		const github = {
			getBranchReference: async () => ({ object: { sha: 'head-new' } }),
			getCommit: async (sha: string) => ({ sha, tree: { sha: remote.treeSha } }),
			readTreeSnapshot: async () => remote,
			getBlob: async () => ({
				content: Buffer.from('newer remote version').toString('base64'),
			}),
		};
		const manager = makeManager(vault, state, github);

		await manager.keepRemote('note.md');

		assert.equal(vault.getText(file), 'my local version');
		const updated = state.conflicts['note.md'];
		assert.equal(updated.remoteSha, gitBlobSha('newer remote version'));
		assert.notEqual(updated.conflictCopyPath, 'note (conflict - test-device).md');
		assert.equal(vault.getText(vault.getAbstractFileByPath(updated.conflictCopyPath) as any), 'newer remote version');
		assert.equal(state.lastSyncedCommit, 'head-old');
	});

	it('does nothing when keep-remote is requested while another sync is running', async () => {
		const vault = new MockVault(TFile);
		vault.addFile('note.md', 'local');
		const state = makeState();
		addConflict(state, 'note.md', 'local', 'remote');
		let clientCalls = 0;
		const manager = makeManager(vault, state, {});
		const runtime = manager as unknown as { running: boolean; getClient: () => object };
		runtime.running = true;
		runtime.getClient = () => {
			clientCalls++;
			throw new Error('keepRemote should return before reading GitHub');
		};

		await manager.keepRemote('note.md');

		assert.equal(clientCalls, 0);
		assert.ok(state.conflicts['note.md']);
		assert.equal(state.lastSyncedCommit, 'head-old');
	});

	it('keeps the conflict when a local edit arrives during keep-remote', async () => {
		const vault = new MockVault(TFile);
		const file = vault.addFile('note.md', 'local');
		const state = makeState();
		addConflict(state, 'note.md', 'local', 'remote note');
		const remote = snapshot(entry('note.md', 'remote note'), entry('other.md', 'other change'));
		const fetchStarted = deferred<void>();
		const resumeFetch = deferred<void>();
		const github = {
			getBranchReference: async () => ({ object: { sha: 'head-new' } }),
			getCommit: async (sha: string) => ({ sha, tree: { sha: remote.treeSha } }),
			readTreeSnapshot: async () => remote,
			getBlob: async () => {
				fetchStarted.resolve();
				await resumeFetch.promise;
				return { content: Buffer.from('remote note').toString('base64') };
			},
		};
		const manager = makeManager(vault, state, github);
		const resolveRemote = manager.keepRemote('note.md');
		await fetchStarted.promise;
		vault.setText(file, 'late local edit');
		resumeFetch.resolve();
		await resolveRemote;

		assert.equal(vault.getText(file), 'late local edit');
		assert.ok(state.conflicts['note.md']);
		assert.equal(state.lastSyncedCommit, 'head-old');
	});

	it('applies the chosen remote path and clears its conflict without advancing the global commit', async () => {
		const vault = new MockVault(TFile);
		const file = vault.addFile('note.md', 'local');
		const state = makeState();
		addConflict(state, 'note.md', 'local', 'remote note');
		const remote = snapshot(entry('note.md', 'remote note'));
		const github = {
			getBranchReference: async () => ({ object: { sha: 'head-new' } }),
			getCommit: async (sha: string) => ({ sha, tree: { sha: remote.treeSha } }),
			readTreeSnapshot: async () => remote,
			getBlob: async () => ({
				content: Buffer.from('remote note').toString('base64'),
			}),
		};
		const manager = makeManager(vault, state, github);

		await manager.keepRemote('note.md');

		assert.equal(vault.getText(file), 'remote note');
		assert.equal(state.conflicts['note.md'], undefined);
		assert.equal(state.lastSyncedCommit, 'head-old');
		assert.equal(state.lastSyncedTree['note.md'], gitBlobSha('remote note'));
	});

	it('clears a remote-deletion conflict after the absent path is reconciled', async () => {
		const vault = new MockVault(TFile);
		const state = makeState();
		addConflict(state, 'gone.md', null, null);
		const remote = snapshot();
		const github = {
			getBranchReference: async () => ({ object: { sha: 'head-new' } }),
			getCommit: async (sha: string) => ({ sha, tree: { sha: remote.treeSha } }),
			readTreeSnapshot: async () => remote,
		};
		const manager = makeManager(vault, state, github);

		await manager.keepRemote('gone.md');

		assert.equal(state.conflicts['gone.md'], undefined);
		assert.equal(state.lastSyncedCommit, 'head-old');
		assert.equal(state.lastSyncedTree['gone.md'], undefined);
	});

	it('clears cached stats on a named dirty path so a same-stat edit gets hashed', async () => {
		const vault = new MockVault(TFile);
		const file = vault.addFile('note.md', 'base');
		const state = makeState();
		state.trackedFiles['note.md'] = {
			localHash: sha256('base'),
			remoteSha: gitBlobSha('base'),
			mtime: file.stat.mtime,
			size: file.stat.size,
		};
		state.lastSyncedTree['note.md'] = gitBlobSha('base');
		const manager = makeManager(vault, state, {});
		vault.setTextAtSameStat(file, 'edit');

		manager.markDirty('note.md');

		assert.equal(state.trackedFiles['note.md'].mtime, undefined);
		assert.equal(state.trackedFiles['note.md'].size, undefined);
		const changes = await new ChangeDetector(vault, settings()).detectLocalChanges(state, ['.md']);
		assert.deepEqual([...changes.modifiedOrCreated], ['note.md']);
	});
});
