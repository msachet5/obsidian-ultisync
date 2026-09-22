import type { App } from 'obsidian';

/**
 * The id the access token in use is filed under in Obsidian's secret storage.
 * Stable for the life of the plugin, because changing it would strand the
 * stored value and silently look like a token that had gone missing.
 */
const SECRET_ID = 'ultisync-token';

/**
 * Every token that has ever passed a connection check is kept under its own
 * id as well, so a reinstall, or a switch between repositories, can offer
 * them back by name instead of asking for a paste. The value is JSON: the
 * token, the repository it was saved for, and when.
 */
const SAVED_PREFIX = 'ultisync-saved-';

/** The slice of Obsidian's SecretStorage this plugin uses. */
interface SecretStorageLike {
	getSecret(id: string): string | null;
	setSecret(id: string, secret: string): void;
	listSecrets(): string[];
}

/** One remembered token, with enough around it to be told from the others. */
export interface SavedToken {
	id: string;
	token: string;
	/** The owner/repo it was saved for, or '' where that was not known. */
	label: string;
	/** ISO timestamp of the first save. */
	savedAt: string;
}

/**
 * Obsidian gained a first-party secret store in 1.11.4. Reaching it through a
 * narrow cast is what lets `minAppVersion` stay at 1.7.2: on an older build the
 * API is simply absent, and the token stays in `data.json` exactly as it did
 * before. The shape is checked rather than assumed, so a future rename of the
 * API degrades to the old path instead of throwing on load.
 */
function secretStorage(app: App): SecretStorageLike | null {
	// Reached through an untyped view of `app` on purpose. Naming Obsidian's own
	// SecretStorage type here would declare a dependency on 1.11.4 and defeat the
	// fallback: the API is optional at runtime, so it is discovered at runtime.
	const candidate = (app as unknown as Record<string, unknown>).secretStorage;
	if (typeof candidate !== 'object' || candidate === null) return null;

	const store = candidate as Partial<SecretStorageLike>;
	return typeof store.getSecret === 'function' &&
		typeof store.setSecret === 'function' &&
		typeof store.listSecrets === 'function'
		? (store as SecretStorageLike)
		: null;
}

/** Whether this Obsidian keeps the token out of the plugin's data file. */
export function usesSecretStorage(app: App): boolean {
	return secretStorage(app) !== null;
}

/** The tail of a token, which is all that can be shown of it. */
export function tokenHint(token: string): string {
	return token.length > 4 ? `…${token.slice(-4)}` : '…';
}

function parseSaved(id: string, raw: string | null): SavedToken | null {
	// An emptied secret is a forgotten one: the store cannot delete, only
	// overwrite, so '' is what forgetting leaves behind.
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return null;
		const { token, label, savedAt } = parsed as Record<string, unknown>;
		if (typeof token !== 'string' || !token) return null;
		return {
			id,
			token,
			label: typeof label === 'string' ? label : '',
			savedAt: typeof savedAt === 'string' ? savedAt : '',
		};
	} catch {
		return null;
	}
}

/** Every remembered token, newest first. Empty where there is no store. */
export function listSavedTokens(app: App): SavedToken[] {
	const store = secretStorage(app);
	if (!store) return [];
	try {
		return store
			.listSecrets()
			.filter((id) => id.startsWith(SAVED_PREFIX))
			.flatMap((id) => {
				const saved = parseSaved(id, store.getSecret(id));
				return saved ? [saved] : [];
			})
			.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
	} catch {
		return [];
	}
}

/**
 * Keeps a token that has just proved it works. The same token saved again
 * keeps its first date and takes the new label, so the list never grows a
 * duplicate and always names the repository it was last used for.
 */
export function rememberToken(app: App, token: string, label: string): void {
	const store = secretStorage(app);
	if (!store || !token) return;
	try {
		const existing = listSavedTokens(app).find((saved) => saved.token === token);
		const id = existing?.id ?? `${SAVED_PREFIX}${Date.now().toString(36)}`;
		const savedAt = existing?.savedAt || new Date().toISOString();
		store.setSecret(id, JSON.stringify({ token, label, savedAt }));
	} catch {
		// A store that refuses the write only loses the convenience.
	}
}

/**
 * Empties every remembered token, and the one in use. The store cannot
 * delete an entry, so each is overwritten with nothing, which is what the
 * list treats as absent.
 */
export function forgetAllTokens(app: App): void {
	const store = secretStorage(app);
	if (!store) return;
	try {
		for (const id of store.listSecrets()) {
			if (id === SECRET_ID || id.startsWith(SAVED_PREFIX)) store.setSecret(id, '');
		}
	} catch {
		// Nothing more can be done about a store that will not write.
	}
}

export interface LoadedToken {
	token: string;
	/** True when the data file still holds a plaintext copy that should go. */
	migrated: boolean;
	/** True when a token from an earlier installation was found and kept
	 *  aside for the saved-token selector rather than adopted. */
	leftover: boolean;
}

/**
 * The token to run with, preferring the secret store over whatever `data.json`
 * holds. A plaintext token left by an earlier version, or written while running
 * on an older Obsidian, is moved into the store on sight. The caller then
 * persists, and that write is what clears it from the vault file.
 *
 * `freshInstall` says there was no data file at all. Uninstalling a plugin
 * removes its folder but not the vault's secret store, and Obsidian offers no
 * hook at uninstall time, so a reinstall is the first moment a leftover token
 * can be noticed. It is not adopted: a credential that reappears on its own
 * reads as one that was never removed. It is kept in the saved list instead,
 * where the settings tab offers it back by name, and taking it up is a click.
 */
export function loadToken(app: App, stored: string, freshInstall = false): LoadedToken {
	const store = secretStorage(app);
	if (!store) return { token: stored, migrated: false, leftover: false };

	try {
		const secret = store.getSecret(SECRET_ID);
		if (secret && freshInstall) {
			rememberToken(app, secret, '');
			return { token: '', migrated: false, leftover: true };
		}
		if (secret) return { token: secret, migrated: stored !== '', leftover: false };
		if (!stored) return { token: '', migrated: false, leftover: false };
		store.setSecret(SECRET_ID, stored);
		return { token: stored, migrated: true, leftover: false };
	} catch {
		// A store that throws is treated as absent. Losing the token would be a
		// worse outcome than storing it where it already was.
		return { token: stored, migrated: false, leftover: false };
	}
}

/**
 * The settings as they should be written to `data.json`. Where the secret store
 * exists the token goes there instead and the field is left empty, so the file
 * inside the vault never carries the credential.
 */
export function settingsForDisk<T extends { token: string }>(app: App, settings: T): T {
	const store = secretStorage(app);
	if (!store) return settings;

	try {
		store.setSecret(SECRET_ID, settings.token);
		return { ...settings, token: '' };
	} catch {
		return settings;
	}
}
