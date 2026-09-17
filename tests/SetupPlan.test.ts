import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { SetupCheckResult } from '../src/sync/SetupCheck.ts';
import { isDecided, isDestructive, planFor } from '../src/sync/SetupPlan.ts';

function result(partial: Partial<SetupCheckResult>): SetupCheckResult {
	return {
		relation: 'both-ahead',
		commitSha: 'abc',
		localOnly: [],
		remoteOnly: [],
		conflicting: [],
		identical: {},
		localCount: 0,
		remoteCount: 0,
		bytesHashed: 0,
		...partial,
	};
}

describe('planFor', () => {
	it('keeps both sides by default: downloads theirs, uploads ours, loses nothing', () => {
		const plan = planFor(
			result({ localOnly: ['a.md', 'b.md'], remoteOnly: ['c.md'] }),
			{ winner: null, extras: 'keep' },
		);
		assert.deepEqual(plan.pull, ['c.md']);
		assert.deepEqual(plan.upload, ['a.md', 'b.md']);
		assert.deepEqual(plan.trashLocal, []);
		assert.deepEqual(plan.deleteRemote, []);
		assert.equal(plan.push, true);
		assert.equal(isDestructive(plan), false);
	});

	it('"only this vault" deletes what only GitHub has and downloads nothing', () => {
		const plan = planFor(
			result({ localOnly: ['a.md'], remoteOnly: ['c.md', 'd.md'] }),
			{ winner: null, extras: 'local-only' },
		);
		assert.deepEqual(plan.pull, []);
		assert.deepEqual(plan.deleteRemote, ['c.md', 'd.md']);
		assert.deepEqual(plan.upload, ['a.md']);
		assert.equal(plan.push, true);
		assert.equal(isDestructive(plan), true);
	});

	it('"only GitHub" trashes what only the vault has and uploads nothing', () => {
		const plan = planFor(
			result({ localOnly: ['a.md'], remoteOnly: ['c.md'] }),
			{ winner: null, extras: 'remote-only' },
		);
		assert.deepEqual(plan.pull, ['c.md']);
		assert.deepEqual(plan.trashLocal, ['a.md']);
		assert.deepEqual(plan.upload, []);
		assert.equal(plan.push, false);
		assert.equal(isDestructive(plan), true);
	});

	it('a local winner uploads the differing files as they are', () => {
		const plan = planFor(
			result({ relation: 'diverged', conflicting: ['x.md'], remoteOnly: ['c.md'] }),
			{ winner: 'local', extras: 'keep' },
		);
		assert.deepEqual(plan.upload, ['x.md']);
		assert.deepEqual(plan.pull, ['c.md']);
		assert.deepEqual(plan.overwriteLocal, []);
		// Replacing GitHub's version is a push, not a deletion, and GitHub
		// keeps the old blob in history: nothing is confirmed for it.
		assert.equal(isDestructive(plan), false);
	});

	it('a remote winner downloads the differing files over the local copies', () => {
		const plan = planFor(
			result({ relation: 'diverged', conflicting: ['x.md'], localOnly: ['a.md'] }),
			{ winner: 'remote', extras: 'keep' },
		);
		assert.deepEqual(plan.pull, ['x.md']);
		assert.deepEqual(plan.overwriteLocal, ['x.md']);
		assert.deepEqual(plan.upload, ['a.md']);
		assert.equal(isDestructive(plan), true);
	});

	it('"only this vault" with a remote winner still downloads the winners', () => {
		const plan = planFor(
			result({ relation: 'diverged', conflicting: ['x.md'], remoteOnly: ['c.md'] }),
			{ winner: 'remote', extras: 'local-only' },
		);
		assert.deepEqual(plan.pull, ['x.md']);
		assert.deepEqual(plan.deleteRemote, ['c.md']);
		assert.equal(plan.push, true);
	});

	it('an up-to-date vault plans nothing at all', () => {
		const plan = planFor(result({ relation: 'up-to-date' }), { winner: null, extras: 'keep' });
		assert.deepEqual(plan.pull, []);
		assert.equal(plan.push, false);
		assert.equal(isDestructive(plan), false);
	});
});

describe('isDecided', () => {
	it('needs a winner only when something differs on both sides', () => {
		assert.equal(isDecided(result({}), { winner: null, extras: 'keep' }), true);
		assert.equal(
			isDecided(result({ conflicting: ['x.md'] }), { winner: null, extras: 'keep' }),
			false,
		);
		assert.equal(
			isDecided(result({ conflicting: ['x.md'] }), { winner: 'local', extras: 'keep' }),
			true,
		);
	});
});
