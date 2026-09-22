import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { App } from 'obsidian';
import {
	forgetAllTokens,
	listSavedTokens,
	loadToken,
	rememberToken,
	settingsForDisk,
	tokenHint,
} from '../src/TokenStore.ts';

/** An App with only the slice of secret storage the store touches. */
function appWithStore(initial: Record<string, string> = {}): {
	app: App;
	secrets: Record<string, string>;
} {
	const secrets = { ...initial };
	const app = {
		secretStorage: {
			getSecret: (id: string): string | null => secrets[id] ?? null,
			setSecret: (id: string, secret: string): void => {
				secrets[id] = secret;
			},
			listSecrets: (): string[] => Object.keys(secrets),
		},
	} as unknown as App;
	return { app, secrets };
}

describe('loadToken', () => {
	it('prefers the secret store over the data file and flags the plaintext copy', () => {
		const { app } = appWithStore({ 'ultisync-token': 'stored' });
		assert.deepEqual(loadToken(app, 'plaintext'), {
			token: 'stored',
			migrated: true,
			leftover: false,
		});
	});

	it('moves a plaintext token into the store on sight', () => {
		const { app, secrets } = appWithStore();
		assert.deepEqual(loadToken(app, 'plaintext'), {
			token: 'plaintext',
			migrated: true,
			leftover: false,
		});
		assert.equal(secrets['ultisync-token'], 'plaintext');
	});

	// Uninstalling removes the plugin folder but not the vault's secret store,
	// so a reinstall is the first chance to notice the leftover. It is offered
	// back, not taken up.
	it('keeps a token left by an earlier installation aside on a fresh install', () => {
		const { app, secrets } = appWithStore({ 'ultisync-token': 'leftover' });
		assert.deepEqual(loadToken(app, '', true), {
			token: '',
			migrated: false,
			leftover: true,
		});
		assert.equal(secrets['ultisync-token'], 'leftover');
		assert.deepEqual(
			listSavedTokens(app).map((saved) => saved.token),
			['leftover'],
		);
	});

	it('keeps the stored token across an ordinary update, where the data file exists', () => {
		const { app } = appWithStore({ 'ultisync-token': 'kept' });
		assert.equal(loadToken(app, '', false).token, 'kept');
	});

	it('falls back to the data file where there is no secret store', () => {
		const app = {} as App;
		assert.deepEqual(loadToken(app, 'plaintext', true), {
			token: 'plaintext',
			migrated: false,
			leftover: false,
		});
	});
});

describe('saved tokens', () => {
	it('remembers a token with its repository and lists it', () => {
		const { app } = appWithStore();
		rememberToken(app, 'github_pat_abcd1234', 'me/vault');
		const [saved] = listSavedTokens(app);
		assert.ok(saved);
		assert.equal(saved.token, 'github_pat_abcd1234');
		assert.equal(saved.label, 'me/vault');
		assert.ok(saved.savedAt);
	});

	it('does not duplicate a token saved twice, and takes the newer label', () => {
		const { app } = appWithStore();
		rememberToken(app, 'tok', 'me/one');
		const first = listSavedTokens(app)[0];
		rememberToken(app, 'tok', 'me/two');
		const list = listSavedTokens(app);
		assert.equal(list.length, 1);
		assert.equal(list[0]?.label, 'me/two');
		assert.equal(list[0]?.savedAt, first?.savedAt);
	});

	it('ignores other plugins\' secrets and entries that were forgotten', () => {
		const { app } = appWithStore({
			'someone-else': 'theirs',
			'ultisync-saved-old': '',
			'ultisync-saved-bad': 'not json',
		});
		rememberToken(app, 'tok', 'me/vault');
		assert.equal(listSavedTokens(app).length, 1);
	});

	it('forgets every saved token and the one in use, leaving others alone', () => {
		const { app, secrets } = appWithStore({
			'ultisync-token': 'active',
			'someone-else': 'theirs',
		});
		rememberToken(app, 'active', 'me/vault');
		forgetAllTokens(app);
		assert.equal(listSavedTokens(app).length, 0);
		assert.equal(secrets['ultisync-token'], '');
		assert.equal(secrets['someone-else'], 'theirs');
	});

	it('shows only the tail of a token', () => {
		assert.equal(tokenHint('github_pat_abcd1234'), '…1234');
		assert.equal(tokenHint('abc'), '…');
	});
});

describe('settingsForDisk', () => {
	it('writes the token to the store and leaves the data file without it', () => {
		const { app, secrets } = appWithStore();
		const onDisk = settingsForDisk(app, { token: 'secret', other: 1 });
		assert.equal(onDisk.token, '');
		assert.equal(onDisk.other, 1);
		assert.equal(secrets['ultisync-token'], 'secret');
	});
});
