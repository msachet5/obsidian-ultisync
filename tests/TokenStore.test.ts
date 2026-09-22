import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { App } from 'obsidian';
import { loadToken, settingsForDisk } from '../src/TokenStore.ts';

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
			discarded: false,
		});
	});

	it('moves a plaintext token into the store on sight', () => {
		const { app, secrets } = appWithStore();
		assert.deepEqual(loadToken(app, 'plaintext'), {
			token: 'plaintext',
			migrated: true,
			discarded: false,
		});
		assert.equal(secrets['ultisync-token'], 'plaintext');
	});

	// Uninstalling removes the plugin folder but not the vault's secret store,
	// so a reinstall is the first chance to notice the leftover.
	it('clears a token left behind by an earlier installation on a fresh install', () => {
		const { app, secrets } = appWithStore({ 'ultisync-token': 'leftover' });
		assert.deepEqual(loadToken(app, '', true), {
			token: '',
			migrated: false,
			discarded: true,
		});
		assert.equal(secrets['ultisync-token'], '');
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
			discarded: false,
		});
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
