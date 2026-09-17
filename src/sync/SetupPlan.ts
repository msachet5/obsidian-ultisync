import type { SetupCheckResult } from './SetupCheck.ts';

/** Which side's version survives for a file that differs in both places. */
export type Winner = 'local' | 'remote';

/**
 * What to do about files that exist on one side only.
 *
 * "keep" combines both sets. "local-only" makes this vault the whole truth
 * and deletes GitHub's extras; "remote-only" does the reverse and trashes the
 * vault's extras. Both of those lose files on purpose, and are confirmed.
 */
export type ExtrasPolicy = 'keep' | 'local-only' | 'remote-only';

export interface SetupDecision {
	/** Required when anything differs on both sides; irrelevant otherwise. */
	winner: Winner | null;
	extras: ExtrasPolicy;
}

/**
 * The concrete work a decision amounts to, as path lists. Everything the
 * adoption then does is driven by this rather than by re-deriving the intent
 * from the two enums at each step.
 */
export interface SetupPlan {
	/** Downloaded from GitHub. Includes the losers of a remote-wins decision. */
	pull: string[];
	/** The subset of `pull` that already exists here and will be replaced. */
	overwriteLocal: string[];
	/** Moved to the vault's trash before the position is recorded. */
	trashLocal: string[];
	/** Removed from GitHub in the adoption commit. */
	deleteRemote: string[];
	/** Whether a push is needed at all: something to upload or to delete. */
	push: boolean;
	/** What that push will upload. Informational; the push finds them itself. */
	upload: string[];
}

export function planFor(result: SetupCheckResult, decision: SetupDecision): SetupPlan {
	const { localOnly, remoteOnly, conflicting } = result;
	const { winner, extras } = decision;

	const pull = [
		...(extras === 'local-only' ? [] : remoteOnly),
		...(winner === 'remote' ? conflicting : []),
	];
	const upload = [
		...(extras === 'remote-only' ? [] : localOnly),
		...(winner === 'local' ? conflicting : []),
	];
	const deleteRemote = extras === 'local-only' ? [...remoteOnly] : [];
	const trashLocal = extras === 'remote-only' ? [...localOnly] : [];

	return {
		pull,
		overwriteLocal: winner === 'remote' ? [...conflicting] : [],
		trashLocal,
		deleteRemote,
		push: upload.length > 0 || deleteRemote.length > 0,
		upload,
	};
}

/** Whether carrying out the plan loses a file somewhere, on purpose. */
export function isDestructive(plan: SetupPlan): boolean {
	return plan.trashLocal.length > 0 || plan.deleteRemote.length > 0 || plan.overwriteLocal.length > 0;
}

/**
 * Whether the decision is complete enough to act on: a winner has to be
 * named whenever there is something for it to win.
 */
export function isDecided(result: SetupCheckResult, decision: SetupDecision): boolean {
	return result.conflicting.length === 0 || decision.winner !== null;
}
