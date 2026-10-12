import { TFile, Vault } from 'obsidian';

/** The caller must keep the current file and report a conflict. */
export class LocalFileChangedError extends Error {
	constructor(path: string) {
		super(`Local content changed before writing ${path}.`);
	}
}

/** Decode only when a text write can preserve the exact bytes. */
export function losslessText(bytes: ArrayBuffer): string | null {
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return null;
	}
}

/** Compare inside Obsidian's atomic read/modify/save operation. */
export async function guardedTextWrite(
	vault: Vault,
	file: TFile,
	expected: ArrayBuffer,
	text: string,
	onBeforeWrite: () => void = () => undefined,
): Promise<void> {
	const original = losslessText(expected);
	if (original === null) throw new LocalFileChangedError(file.path);
	const path = file.path;
	await vault.process(file, (current) => {
		if (current !== original || file.path !== path || vault.getAbstractFileByPath(path) !== file) {
			throw new LocalFileChangedError(path);
		}
		onBeforeWrite();
		return text;
	});
}
