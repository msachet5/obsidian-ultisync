export const PULL_INTERVAL_MS = 5000;
export const POLL_HOLD_AFTER_PUSH_MS = 10000;
export const PUSH_DELAY_SECONDS = 5;
export const ACTIVITY_LIMIT = 30;

/**
 * A transfer says nothing about itself until it is big enough to be worth
 * watching. Below these it is over before the eye settles on it, and a count
 * that flickers past is worse than no count at all.
 */
export const PROGRESS_MIN_FILES = 10;
export const PROGRESS_MIN_BYTES = 25 * 1024 * 1024;

/**
 * How often the vault is checked against what the record says it holds. The
 * check itself is local arithmetic; only a mismatch costs a request.
 */
export const VERIFY_INTERVAL_MS = 60000;

/**
 * How often the thorough check runs at most. It costs a tree read, and a
 * window that is clicked in and out of every few seconds should not pay that
 * each time; a device that has been away for a while still gets it.
 */
export const DEEP_VERIFY_INTERVAL_MS = 5 * 60 * 1000;

/** How often the progress bar and the push countdown are repainted. Fast
 *  enough that a five-second ring drains smoothly, cheap enough to run while
 *  nothing is happening: the paint returns immediately when both are idle. */
export const PROGRESS_TICK_MS = 100;
export const NEW_FILE_SETTLE_MS = 60000;

/** sha1 of an empty blob, and of an empty tree. Both are fixed Git constants. */
export const EMPTY_BLOB_SHA = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** How long a path the plugin just wrote is exempt from looking like a user edit. */
export const SELF_WRITE_GRACE_MS = 2000;

export interface UltiSyncSettings {
	/** Master switch. Off until the setup check reaches a conclusion. */
	syncEnabled: boolean;
	githubOwner: string;
	githubRepo: string;
	branch: string;
	token: string;
	pullExtensions: string[];
	pushExtensions: string[];
	ignoredPaths: string[];
}

/**
 * What the plugin remembers about one synchronized path. `localHash` is the
 * sha-256 of the bytes on disk, `remoteSha` the Git blob sha of the same
 * content on GitHub. `mtime` and `size` are the change detector's fast path.
 */
export interface TrackedFile {
	localHash: string;
	remoteSha: string;
	mtime?: number;
	size?: number;
}

export interface ConflictRecord {
	path: string;
	/** ISO timestamp, so a record survives a reload and still reads sensibly. */
	detectedAt: string;
	localHash: string | null;
	remoteSha: string | null;
	remoteExists: boolean;
	conflictCopyPath: string | null;
}

export interface SyncStateData {
	deviceId: string;
	lastSyncedCommit: string | null;
	lastRemoteCheck: string | null;
	lastSuccessfulPull: string | null;
	lastSuccessfulPush: string | null;
	trackedFiles: Record<string, TrackedFile>;
	conflicts: Record<string, ConflictRecord>;
	/** Every blob path of the tree at `lastSyncedCommit`, mapped to its sha. */
	lastSyncedTree: Record<string, string>;
	/** Old path to new path, for renames made locally but not yet pushed. */
	pendingRenames: Record<string, string>;
	debugLog: string[];
}

/** What the plugin writes to data.json. */
export interface PersistedData {
	/** Lets a later build recognise and upgrade what an earlier one wrote. */
	schemaVersion: number;
	settings: UltiSyncSettings;
	state: SyncStateData;
}

/** The file types Obsidian itself can open. Nothing outside this list syncs. */
export const SUPPORTED_EXTENSIONS = [
	'.md',
	'.canvas',
	'.base',
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.svg',
	'.bmp',
	'.avif',
	'.pdf',
	'.mp3',
	'.wav',
	'.m4a',
	'.ogg',
	'.3gp',
	'.flac',
	'.mp4',
	'.webm',
	'.ogv',
	'.mov',
	'.mkv',
];

/**
 * What a vault syncs before anyone changes anything: notes, the two Obsidian
 * file formats, and the small image types people actually paste into notes.
 *
 * Audio, video and PDF are supported but deliberately left off. They are the
 * file types large enough to run into GitHub's per-blob ceiling and to make a
 * first sync painfully slow, and unlike notes they are rarely the thing
 * someone urgently needs on two devices. They are one checkbox away.
 */
export const DEFAULT_EXTENSIONS = [
	'.md',
	'.canvas',
	'.base',
	'.png',
	'.jpg',
	'.jpeg',
	'.webp',
	'.svg',
];

/** Warn beyond this before hashing, because the check stops feeling instant. */
export const LARGE_CHECK_BYTES = 200 * 1024 * 1024;

/**
 * GitHub warns above this size but still accepts the push, so the file is sent
 * and the warning is passed on rather than the file being withheld.
 */
export const LARGE_FILE_WARN_BYTES = 50 * 1024 * 1024;

/**
 * GitHub blocks any single file above this outright. Attempting one wastes an
 * upload of the whole file to earn a refusal, so it is reported instead.
 */
export const MAX_BLOB_BYTES = 100 * 1024 * 1024;

export const DEFAULT_SETTINGS: UltiSyncSettings = {
	syncEnabled: true,
	githubOwner: '',
	githubRepo: '',
	branch: 'main',
	token: '',
	pullExtensions: [...DEFAULT_EXTENSIONS],
	pushExtensions: [...DEFAULT_EXTENSIONS],
	ignoredPaths: [],
};

export const DEFAULT_STATE: SyncStateData = {
	deviceId: '',
	lastSyncedCommit: null,
	lastRemoteCheck: null,
	lastSuccessfulPull: null,
	lastSuccessfulPush: null,
	trackedFiles: {},
	conflicts: {},
	lastSyncedTree: {},
	pendingRenames: {},
	debugLog: [],
};



/**
 * Whether the plugin can currently reach the repository at all. This covers
 * the network, the credentials and the repository together, because from the
 * user's side they are one question: is it working or not.
 */
export type ConnectionState = 'incomplete' | 'checking' | 'healthy' | 'failed';

export type SyncStatus =
	/** No repository configured yet. */
	| 'setup'
	/** Configured, but the switch is off. */
	| 'off'
	| 'pending'
	| 'syncing'
	| 'pulling'
	| 'pushing'
	| 'synced'
	| 'conflict'
	| 'error';

/**
 * How far a transfer has got. Files rather than bytes: a pull of forty notes
 * and one attachment is forty-one steps to the person watching it, whatever
 * the byte totals say.
 */
export interface SyncProgress {
	phase: SyncPhase;
	done: number;
	total: number;
}

/**
 * What a transfer is doing. "check" is the setup comparison hashing files it
 * has to read, "clear" is a reset trashing the local copies before it pulls.
 */
export type SyncPhase = 'pull' | 'push' | 'check' | 'clear';

export const PHASE_VERB: Record<SyncPhase, string> = {
	pull: 'Pulling',
	push: 'Pushing',
	check: 'Checking',
	clear: 'Clearing',
};

/** A push waiting out the debounce window, and how much of it is left. */
export interface PushCountdown {
	/** Milliseconds still to wait. */
	remaining: number;
	/** The full window this countdown started from. */
	total: number;
}

/** Whole percent complete, clamped so a miscount cannot read past 100. */
export function progressPercent(progress: SyncProgress): number {
	if (progress.total <= 0) return 0;
	return Math.min(100, Math.round((progress.done / progress.total) * 100));
}

/**
 * How much of the countdown ring is still filled: 1 the moment it is armed,
 * 0 when the push goes. Clamped, because a tick can land a little past the
 * deadline.
 */
export function countdownFraction(countdown: PushCountdown): number {
	if (countdown.total <= 0) return 0;
	return Math.min(1, Math.max(0, countdown.remaining / countdown.total));
}

export type ActivityKind = 'info' | 'pull' | 'push' | 'merge' | 'conflict' | 'error';

export interface ActivityEntry {
	at: number;
	kind: ActivityKind;
	text: string;
}

/** Why a push is running. Only "manual" may confirm a bulk deletion, and
 *  "adopt" never deletes at all. */
export type PushTrigger = 'automatic' | 'manual' | 'adopt';
