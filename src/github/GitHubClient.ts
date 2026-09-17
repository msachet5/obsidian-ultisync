import { requestUrl } from 'obsidian';
import { EMPTY_TREE_SHA } from '../types';

export interface GitReference {
	ref: string;
	url: string;
	object: { sha: string; type: string; url: string };
}

export interface GitCommit {
	sha: string;
	message: string;
	tree: { sha: string; url: string };
	parents: { sha: string }[];
}

export interface GitTreeEntry {
	path: string;
	mode: string;
	type: string;
	sha: string;
	size?: number;
	url?: string;
}

export interface GitTree {
	sha: string;
	url: string;
	tree: GitTreeEntry[];
	truncated: boolean;
}

export interface GitBlob {
	sha: string;
	content: string;
	encoding: string;
	size: number;
}

/** A tree entry being written. A null sha deletes the path from the base tree. */
export interface NewTreeEntry {
	path: string;
	mode: string;
	type: string;
	sha: string | null;
}

/** The remote tree at one commit, keyed by path. Blobs only. */
export interface RemoteSnapshot {
	commitSha: string;
	treeSha: string;
	entries: Map<string, GitTreeEntry>;
}

export type CompareStatus = 'ahead' | 'behind' | 'identical' | 'diverged';

export interface CompareResult {
	status: CompareStatus;
	commits: { sha: string; message: string }[];
}

interface ConditionalResponse<T> {
	status: number;
	body: T | undefined;
	etag: string | undefined;
}

/** What GitHub said about the rate limit on the response that was refused. */
export interface RateLimitInfo {
	/** Seconds from `retry-after`, when GitHub named a wait itself. */
	retryAfter?: number;
	/** Epoch seconds from `x-ratelimit-reset`, when the hourly budget refills. */
	reset?: number;
	/** Requests left in the current window, from `x-ratelimit-remaining`. */
	remaining?: number;
}

export class GitHubApiError extends Error {
	readonly status: number;
	readonly raw: unknown;
	readonly rate: RateLimitInfo | undefined;

	constructor(status: number, message: string, raw?: unknown, rate?: RateLimitInfo) {
		super(message);
		this.name = 'GitHubApiError';
		this.status = status;
		this.raw = raw;
		this.rate = rate;
	}
}

/**
 * True when the branch simply is not there yet: either the repository has no
 * commits at all (409) or this branch has never been created (404). Both mean
 * the same thing to the plugin, which is that there is nothing to compare
 * against and the first push has to create the history.
 */
export function isMissingBranch(error: unknown): boolean {
	return error instanceof GitHubApiError && (error.status === 404 || error.status === 409);
}

/**
 * True when GitHub refused because of a rate limit rather than because
 * something is actually wrong. The primary hourly budget answers 403 or 429
 * with `x-ratelimit-remaining: 0`; a secondary limit answers with
 * `retry-after`, or with a message that names the limit.
 */
export function isRateLimited(error: unknown): boolean {
	if (!(error instanceof GitHubApiError)) return false;
	if (error.status !== 403 && error.status !== 429) return false;
	if (error.rate?.retryAfter !== undefined) return true;
	if (error.rate?.remaining === 0) return true;
	return /rate limit|secondary|abuse/i.test(error.message);
}

/** Longest wait worth honouring. The hourly budget always resets within this. */
const MAX_RATE_LIMIT_WAIT_MS = 60 * 60 * 1000;

/**
 * How long to leave the API alone, following GitHub's own guidance: honour
 * `retry-after` when it is present, otherwise wait for the window to reset,
 * otherwise wait the minute GitHub asks for when it says nothing specific.
 */
export function rateLimitDelayMs(error: unknown, now = Date.now()): number {
	const fallback = 60 * 1000;
	const rate = error instanceof GitHubApiError ? error.rate : undefined;
	if (!rate) return fallback;
	if (rate.retryAfter !== undefined && rate.retryAfter > 0) {
		return Math.min(rate.retryAfter * 1000, MAX_RATE_LIMIT_WAIT_MS);
	}
	if (rate.reset !== undefined) {
		const until = rate.reset * 1000 - now;
		if (until > 0) return Math.min(until, MAX_RATE_LIMIT_WAIT_MS);
	}
	return fallback;
}

/**
 * True when GitHub refused one blob for its size. Files over 100 MiB are
 * blocked outright, and base64 encoding inflates the request body by about a
 * third, so a file under that limit can still be refused as a payload.
 */
export function isTooLargeError(error: unknown): boolean {
	if (!(error instanceof GitHubApiError)) return false;
	if (error.status === 413) return true;
	return (
		(error.status === 400 || error.status === 422) &&
		/too large|too big|exceeds|payload|size limit/i.test(error.message)
	);
}

/**
 * True when GitHub (or the edge in front of it) failed in a way that has
 * nothing to do with the request itself — a bad gateway, an overloaded
 * server, a timeout. These are common on the very first push, which asks the
 * Git Database API to build a tree covering the whole vault in one call, and
 * they clear up on their own within a few seconds.
 */
export function isTransientServerError(error: unknown): boolean {
	if (!(error instanceof GitHubApiError)) return false;
	return error.status === 502 || error.status === 503 || error.status === 504;
}

/** Retries for a transient server error, before giving up and surfacing it. */
const MAX_TRANSIENT_RETRIES = 4;
const TRANSIENT_RETRY_BACKOFF_MS = [500, 1500, 3000, 5000];

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** ETag per owner/repo/branch, so an unchanged branch read costs no rate limit. */
const branchRefCache = new Map<string, { etag: string; ref: GitReference }>();

/** The last commit this installation placed on a branch, to spot stale reads. */
const lastPushedHead = new Map<string, string>();

function headerOf(
	headers: Record<string, string> | undefined,
	name: string,
): string | undefined {
	if (!headers) return undefined;
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === wanted) return value;
	}
	return undefined;
}

function readEtag(headers: Record<string, string> | undefined): string | undefined {
	return headerOf(headers, 'etag');
}

function numberHeader(
	headers: Record<string, string> | undefined,
	name: string,
): number | undefined {
	const raw = headerOf(headers, name);
	if (raw === undefined) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

/**
 * GitHub reports a rate limit through headers rather than the body:
 * `retry-after` on a secondary limit, and `x-ratelimit-remaining` with
 * `x-ratelimit-reset` for the hourly budget. Captured on every refusal so the
 * plugin can wait exactly as long as GitHub asked rather than guessing.
 */
function rateLimitOf(headers: Record<string, string> | undefined): RateLimitInfo | undefined {
	const retryAfter = numberHeader(headers, 'retry-after');
	const reset = numberHeader(headers, 'x-ratelimit-reset');
	const remaining = numberHeader(headers, 'x-ratelimit-remaining');
	if (retryAfter === undefined && reset === undefined && remaining === undefined) {
		return undefined;
	}
	return {
		...(retryAfter === undefined ? {} : { retryAfter }),
		...(reset === undefined ? {} : { reset }),
		...(remaining === undefined ? {} : { remaining }),
	};
}

function parseBody(text: string | undefined): unknown {
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** GitHub puts the useful part of an error in a `message` field. */
function messageOf(parsed: unknown, fallback: string): string {
	if (typeof parsed === 'object' && parsed !== null && 'message' in parsed) {
		const { message } = parsed;
		if (typeof message === 'string') return message;
	}
	return fallback;
}

export class GitHubClient {
	private readonly baseUrl = 'https://api.github.com';
	private readonly apiVersion = '2026-03-10';

	constructor(
		private owner: string,
		private repo: string,
		private token: string,
		private branch: string,
	) {}

	private ensureConfigured(): void {
		if (!this.owner || !this.repo || !this.token) {
			throw new GitHubApiError(400, 'GitHub owner, repository and token are required.');
		}
	}

	private headers(): Record<string, string> {
		return {
			Accept: 'application/vnd.github+json',
			Authorization: `Bearer ${this.token}`,
			'X-GitHub-Api-Version': this.apiVersion,
			'User-Agent': 'ultisync',
			// requestUrl goes through the platform's own HTTP cache (Chromium on
			// desktop, the system cache on iOS), and GitHub marks API answers
			// cacheable for a minute. A poll served from that cache reports a
			// branch that has not moved when it has. The plugin does its own
			// conditional requests, so nothing is lost by refusing the cache.
			'Cache-Control': 'no-cache',
			Pragma: 'no-cache',
		};
	}

	private repoPath(suffix: string): string {
		return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${suffix}`;
	}

	private cacheKey(): string {
		return `${this.owner}/${this.repo}/${this.branch}`;
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		this.ensureConfigured();
		for (let attempt = 0; ; attempt++) {
			try {
				const response = await requestUrl({
					url: `${this.baseUrl}${path}`,
					method,
					headers: this.headers(),
					body: body === undefined ? undefined : JSON.stringify(body),
					throw: false,
				});
				const parsed = parseBody(response.text);
				if (response.status < 200 || response.status >= 300) {
					throw new GitHubApiError(
						response.status,
						`${messageOf(parsed, `HTTP ${response.status}`)} (${method} ${path})`,
						parsed,
						rateLimitOf(response.headers),
					);
				}
				return parsed as T;
			} catch (error) {
				const wrapped =
					error instanceof GitHubApiError
						? error
						: new GitHubApiError(0, 'Unable to reach GitHub. Check the network connection.', error);
				if (isTransientServerError(wrapped) && attempt < MAX_TRANSIENT_RETRIES) {
					await sleep(TRANSIENT_RETRY_BACKOFF_MS[attempt] ?? 5000);
					continue;
				}
				throw wrapped;
			}
		}
	}

	// The branch head is read on every poll, so it is fetched conditionally.
	// GitHub answers an unchanged ref with 304 Not Modified, which carries no
	// body and does not count against the rate limit. If the ETag header is ever
	// absent the cache simply stays empty and this behaves like a plain GET.
	async getBranchReference(skipCache = false): Promise<GitReference> {
		const branch = encodeURIComponent(this.branchRef());
		// A fresh query string each time is the one thing every HTTP cache
		// respects. GitHub ignores the parameter, and the ETag is computed
		// from the body, so the conditional request still answers 304.
		const path = this.repoPath(`/git/ref/${branch}?t=${Date.now()}`);
		const key = this.cacheKey();
		const cached = skipCache ? undefined : branchRefCache.get(key);

		const result = await this.conditionalGet<GitReference>(path, cached?.etag);
		if (result.status === 304 && cached) {
			return cached.ref;
		}
		if (!result.body) {
			throw new GitHubApiError(0, 'GitHub returned an empty branch reference.');
		}
		if (result.etag) {
			branchRefCache.set(key, { etag: result.etag, ref: result.body });
		} else {
			branchRefCache.delete(key);
		}
		return result.body;
	}

	// Drops the cached ETag for the branch, forcing the next read to be answered
	// with a body rather than a 304. Used when the cached head turns out to be
	// older than the commit this vault has already reconciled: continuing to
	// serve it would keep the vault pinned to the past.
	invalidateBranchCache(): void {
		branchRefCache.delete(this.cacheKey());
	}

	// True when a branch read came back older than a commit this installation has
	// already placed on that branch, meaning a stale replica rather than a branch
	// that moved.
	//
	// Building a commit on top of such a head is guaranteed to be rejected as a
	// non-fast-forward, because the parent is not the real tip. Costs nothing in
	// the ordinary case: when the read matches what we last pushed, or when we
	// have pushed nothing yet, no request is made.
	async isStaleHead(headSha: string): Promise<boolean> {
		const known = lastPushedHead.get(this.cacheKey());
		if (!known || known === headSha) return false;
		try {
			return (await this.compareCommits(headSha, known)).status === 'ahead';
		} catch {
			return true;
		}
	}

	private async conditionalGet<T>(
		path: string,
		etag: string | undefined,
	): Promise<ConditionalResponse<T>> {
		this.ensureConfigured();
		const headers = this.headers();
		if (etag) {
			headers['If-None-Match'] = etag;
		}
		for (let attempt = 0; ; attempt++) {
			try {
				const response = await requestUrl({
					url: `${this.baseUrl}${path}`,
					method: 'GET',
					headers,
					throw: false,
				});
				if (response.status === 304) {
					return { status: 304, body: undefined, etag };
				}
				const parsed = parseBody(response.text);
				if (response.status < 200 || response.status >= 300) {
					throw new GitHubApiError(
						response.status,
						`${messageOf(parsed, `HTTP ${response.status}`)} (GET ${path})`,
						parsed,
						rateLimitOf(response.headers),
					);
				}
				return {
					status: response.status,
					body: parsed as T | undefined,
					etag: readEtag(response.headers),
				};
			} catch (error) {
				const wrapped =
					error instanceof GitHubApiError
						? error
						: new GitHubApiError(0, 'Unable to reach GitHub. Check the network connection.', error);
				if (isTransientServerError(wrapped) && attempt < MAX_TRANSIENT_RETRIES) {
					await sleep(TRANSIENT_RETRY_BACKOFF_MS[attempt] ?? 5000);
					continue;
				}
				throw wrapped;
			}
		}
	}

	async getCommit(shaOrRef: string): Promise<GitCommit> {
		return this.request('GET', this.repoPath(`/git/commits/${encodeURIComponent(shaOrRef)}`));
	}

	// How head relates to base, in one request. "ahead" means base is an ancestor
	// of head, the ordinary case where the remote has simply moved forward.
	//
	// This is the guard that replaced waiting a minute to see whether a file
	// stayed missing. GitHub's Git Database API is read-after-write eventually
	// consistent, so a read taken moments after a push can hand back an older
	// commit, whose tree is missing files that genuinely exist. Against that
	// older tree every one of those files reads as a deletion. Asking how the two
	// commits are related turns that from an indistinguishable case into a
	// "behind", and deletions are simply not applied unless the answer is "ahead".
	async compareCommits(baseSha: string, headSha: string): Promise<CompareResult> {
		const response = await this.request<{
			status?: string;
			commits?: { sha: string; commit?: { message?: string } }[];
		}>(
			'GET',
			this.repoPath(
				`/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`,
			),
		);
		const commits = (response.commits ?? []).map((entry) => ({
			sha: entry.sha,
			message: entry.commit?.message ?? '',
		}));

		switch (response.status) {
			case 'ahead':
			case 'behind':
			case 'identical':
			case 'diverged':
				return { status: response.status, commits };
			default:
				return { status: 'diverged', commits };
		}
	}

	async getTree(treeSha: string, recursive = true): Promise<GitTree> {
		if (treeSha === EMPTY_TREE_SHA) {
			return { sha: treeSha, url: '', tree: [], truncated: false };
		}
		const query = recursive ? '?recursive=1' : '';
		return this.request('GET', this.repoPath(`/git/trees/${encodeURIComponent(treeSha)}${query}`));
	}

	/**
	 * The blob entries of one commit's tree, keyed by path. A truncated
	 * response is refused rather than silently treated as a smaller tree,
	 * which would read as a mass deletion.
	 */
	async readTreeSnapshot(commitSha: string, treeSha: string): Promise<RemoteSnapshot> {
		const response = await this.getTree(treeSha, true);
		if (response.truncated) {
			throw new Error(
				"The GitHub tree is too large for recursive retrieval. This first version requires a repository tree within GitHub's recursive tree limit.",
			);
		}
		const entries = new Map<string, GitTreeEntry>();
		for (const entry of response.tree) {
			if (entry.type === 'blob' && entry.mode !== '120000') {
				entries.set(entry.path.replace(/\\/g, '/'), entry);
			}
		}
		return { commitSha, treeSha, entries };
	}

	async getBlob(sha: string): Promise<GitBlob> {
		return this.request('GET', this.repoPath(`/git/blobs/${encodeURIComponent(sha)}`));
	}

	async createBlob(content: string, encoding: string): Promise<GitBlob> {
		return this.request('POST', this.repoPath('/git/blobs'), { content, encoding });
	}

	/** A null base tree builds the tree from nothing, for a first commit. */
	async createTree(baseTreeSha: string | null, tree: NewTreeEntry[]): Promise<GitTree> {
		return this.request('POST', this.repoPath('/git/trees'), {
			...(baseTreeSha === null ? {} : { base_tree: baseTreeSha }),
			tree,
		});
	}

	/** A null parent creates a root commit, which is what an empty repo needs. */
	async createCommit(
		message: string,
		treeSha: string,
		parentSha: string | null,
	): Promise<GitCommit> {
		return this.request('POST', this.repoPath('/git/commits'), {
			message,
			tree: treeSha,
			parents: parentSha === null ? [] : [parentSha],
		});
	}

	/** Creates the branch itself. Only used when the repository had no commits. */
	async createReference(commitSha: string): Promise<GitReference> {
		const created = await this.request<GitReference>('POST', this.repoPath('/git/refs'), {
			ref: `refs/heads/${this.branch}`,
			sha: commitSha,
		});
		lastPushedHead.set(this.cacheKey(), commitSha);
		return created;
	}

	/** The branch head, or null when the branch does not exist yet. */
	async getBranchReferenceOrNull(skipCache = false): Promise<GitReference | null> {
		try {
			return await this.getBranchReference(skipCache);
		} catch (error) {
			if (isMissingBranch(error)) return null;
			throw error;
		}
	}

	async updateReference(currentRef: GitReference, newCommitSha: string): Promise<GitReference> {
		const branchName = currentRef.ref.replace(/^refs\/heads\//, '');
		branchRefCache.delete(this.cacheKey());
		const updated = await this.request<GitReference>(
			'PATCH',
			this.repoPath(`/git/refs/heads/${encodeURIComponent(branchName)}`),
			{ sha: newCommitSha, force: false },
		);
		lastPushedHead.set(this.cacheKey(), newCommitSha);
		return updated;
	}

	private branchRef(): string {
		return `heads/${this.branch}`;
	}
}
