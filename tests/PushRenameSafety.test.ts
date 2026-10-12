import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { cleanupManagerBundle, managers } from './load-managers.mjs';
import { deferred, makeApp, MockVault } from './mock-vault.ts';
import { DEFAULT_SETTINGS, DEFAULT_STATE } from '../src/types.ts';

const { SyncManager, PushManager, ChangeDetector, TFile } = managers;
const encode = (text: string) => new TextEncoder().encode(text).buffer;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const sha = (text: string) => createHash('sha1')
	.update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const blob = (text: string) => ({ content: Buffer.from(text).toString('base64') });
const settings = { ...DEFAULT_SETTINGS, pullExtensions: ['.md'], pushExtensions: ['.md'] };

function fixture(text = 'base') {
	const vault = new MockVault(TFile);
	const file = vault.addFile('old.md', text);
	const state = structuredClone(DEFAULT_STATE);
	state.lastSyncedCommit = 'old-head';
	state.deviceId = 'test';
	state.trackedFiles['old.md'] = {
		localHash: hash('base'), remoteSha: sha('base'), mtime: 1, size: 4,
	};
	state.lastSyncedTree['old.md'] = sha('base');
	const manager = new SyncManager(makeApp(vault), settings,
		{ save: async () => undefined }, state, () => undefined, () => undefined);
	// Avoid timers and network outside each controlled test.
	manager.debug = () => undefined;
	manager.scheduleDebouncedPush = () => undefined;
	return { vault, file, state, manager };
}

function remote(path: string, text: string) {
	return { commitSha: 'head', treeSha: 'tree', entries: new Map([[path, {
		path, type: 'blob', sha: sha(text), mode: '100644', size: Buffer.byteLength(text),
	}]]) };
}

after(cleanupManagerBundle);

describe('remote renames', () => {
	it('keeps a locally edited source at its original path', async () => {
		const { vault, file, state, manager } = fixture('my edit');
		const changed = new Set(['new.md']);
		const deleted = new Set(['old.md']);
		const count = await manager.applyRemoteRenames(new Map([['old.md', 'new.md']]),
			remote('new.md', 'base'), deleted, changed);
		assert.equal(count, 0);
		assert.equal(vault.getText(file), 'my edit');
		assert.equal(file.path, 'old.md');
		assert.ok(deleted.has('old.md'));
		assert.ok(changed.has('new.md'));
		assert.equal(state.trackedFiles['old.md']?.remoteSha, sha('base'));
	});

	it('leaves a declared rename with remote edits for the ordinary pull', async () => {
		const { file, manager } = fixture();
		const changed = new Set(['new.md']);
		const count = await manager.applyRemoteRenames(new Map([['old.md', 'new.md']]),
			remote('new.md', 'edited remotely'), new Set(['old.md']), changed);
		assert.equal(count, 0);
		assert.equal(file.path, 'old.md');
		assert.ok(changed.has('new.md'));
	});

	it('moves a clean file and rediscovers an edit made during the move', async () => {
		const { vault, file, state, manager } = fixture();
		const rename = vault.rename.bind(vault);
		vault.rename = async (moving, path) => {
			vault.setText(moving, 'edit during rename');
			await rename(moving, path);
		};
		assert.equal(await manager.applyRemoteRenames(new Map([['old.md', 'new.md']]),
			remote('new.md', 'base'), new Set(['old.md']), new Set(['new.md'])), 1);
		assert.equal(file.path, 'new.md');
		assert.equal(vault.getText(file), 'edit during rename');
		const changes = await new ChangeDetector(vault, settings).detectLocalChanges(state, ['.md']);
		assert.ok(changes.modifiedOrCreated.has('new.md'));
	});
});

describe('push and merge races', () => {
	it('rediscovers an edit made while the previous bytes upload', async () => {
		const { vault, file, state } = fixture('first edit');
		const download = remote('old.md', 'base');
		const entered = deferred<void>();
		const resume = deferred<void>();
		const github = {
			getBranchReferenceOrNull: async () => ({ object: { sha: 'old-head' } }),
			isStaleHead: async () => false,
			getCommit: async () => ({ tree: { sha: 'tree' } }),
			readTreeSnapshot: async () => download,
			createBlob: async () => { entered.resolve(); await resume.promise; return { sha: sha('first edit') }; },
			createTree: async () => ({ sha: 'new-tree' }),
			createCommit: async () => ({ sha: 'new-head' }),
			updateReference: async () => undefined,
		};
		const push = new PushManager(vault, github, settings).push(state, { includeDeletions: false });
		await entered.promise;
		vault.setText(file, 'later edit');
		resume.resolve();
		await push;
		assert.equal(vault.getText(file), 'later edit');
		assert.equal(state.trackedFiles['old.md']?.localHash, hash('first edit'));
		const changes = await new ChangeDetector(vault, settings).detectLocalChanges(state, ['.md']);
		assert.ok(changes.modifiedOrCreated.has('old.md'));
	});

	it('keeps text edited while a pull merge waits for its base and remote blobs', async () => {
		const { vault, file, state, manager } = fixture('ONE\ntwo\nthree');
		state.trackedFiles['old.md'] = { localHash: hash('one\ntwo\nthree'), remoteSha: sha('one\ntwo\nthree') };
		const entered = deferred<void>();
		const resume = deferred<void>();
		const github = { getBlob: async (wanted: string) => {
			entered.resolve(); await resume.promise;
			return blob(wanted === sha('one\ntwo\nthree') ? 'one\ntwo\nthree' : 'one\ntwo\nTHREE');
		} };
		const merge = manager.mergeDivergence('old.md', remote('old.md', 'one\ntwo\nTHREE'), github);
		await entered.promise;
		vault.setText(file, 'latest local thought');
		resume.resolve();
		assert.equal(await merge, false);
		assert.equal(vault.getText(file), 'latest local thought');
	});

	it('reports a push collision when text changes before a prepared merge writes', async () => {
		const { vault, file, state } = fixture('ONE\ntwo\nthree');
		state.trackedFiles['old.md'] = { localHash: hash('one\ntwo\nthree'), remoteSha: sha('one\ntwo\nthree') };
		const download = remote('old.md', 'one\ntwo\nTHREE');
		vault.beforeProcessCallback = async () => { vault.setText(file, 'latest local thought'); };
		const github = {
			getBranchReferenceOrNull: async () => ({ object: { sha: 'head' } }),
			isStaleHead: async () => false,
			getCommit: async () => ({ tree: { sha: 'tree' } }),
			readTreeSnapshot: async () => download,
			getBlob: async (wanted: string) => blob(wanted === sha('one\ntwo\nthree') ? 'one\ntwo\nthree' : 'one\ntwo\nTHREE'),
			createBlob: async () => { throw new Error('A stale merge must never upload'); },
		};
		const result = await new PushManager(vault, github, settings).push(state, { includeDeletions: false });
		assert.deepEqual(result.collisions, ['old.md']);
		assert.equal(vault.getText(file), 'latest local thought');
	});
});
