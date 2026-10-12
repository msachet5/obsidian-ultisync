import type { TFile as TFileType } from './obsidian-mock.ts';

type FileConstructor = new (path: string, bytes: Uint8Array) => TFileType & {
	bytes: Uint8Array;
};

type Folder = { path: string; kind: 'folder' };
type MockFile = TFileType & { bytes: Uint8Array };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class MockVault {
	private entries = new Map<string, MockFile | Folder>();
	pluginWrites = 0;
	beforeProcessCallback: ((file: MockFile) => Promise<void>) | null = null;
	beforeModifyBinary: ((file: MockFile) => Promise<void>) | null = null;
	beforeCreateFolder: ((path: string) => Promise<void>) | null = null;
	beforeCreateBinary: ((path: string) => Promise<void>) | null = null;
	private FileType: FileConstructor;

	constructor(TFile: FileConstructor) {
		this.FileType = TFile;
	}

	addFile(path: string, text: string): MockFile {
		const existing = this.entries.get(path);
		if (existing) throw new Error(`Path already exists: ${path}`);
		const file = new this.FileType(path, encoder.encode(text));
		this.entries.set(path, file);
		return file;
	}

	addFolder(path: string): void {
		if (this.entries.has(path)) throw new Error(`Path already exists: ${path}`);
		this.entries.set(path, { path, kind: 'folder' });
	}

	setText(file: MockFile, text: string): void {
		this.setBytes(file, encoder.encode(text));
	}

	setTextAtSameStat(file: MockFile, text: string): void {
		file.bytes = encoder.encode(text);
	}

	getText(file: MockFile): string {
		return decoder.decode(file.bytes);
	}

	getAbstractFileByPath(path: string): MockFile | Folder | null {
		return this.entries.get(path) ?? null;
	}

	getFiles(): MockFile[] {
		return [...this.entries.values()].filter(
			(entry): entry is MockFile => entry instanceof this.FileType,
		);
	}

	async readBinary(file: MockFile): Promise<ArrayBuffer> {
		return file.bytes.slice().buffer;
	}

	async modifyBinary(file: MockFile, bytes: ArrayBuffer): Promise<void> {
		await this.beforeModifyBinary?.(file);
		if (this.entries.get(file.path) !== file) {
			throw new Error(`File is no longer at ${file.path}`);
		}
		this.setBytes(file, new Uint8Array(bytes));
		this.pluginWrites++;
	}

	async createBinary(path: string, bytes: ArrayBuffer): Promise<MockFile> {
		await this.beforeCreateBinary?.(path);
		if (this.entries.has(path)) throw new Error(`Path already exists: ${path}`);
		const file = new this.FileType(path, new Uint8Array(bytes));
		this.entries.set(path, file);
		this.pluginWrites++;
		return file;
	}

	async createFolder(path: string): Promise<Folder> {
		await this.beforeCreateFolder?.(path);
		if (this.entries.has(path)) throw new Error(`Path already exists: ${path}`);
		const folder = { path, kind: 'folder' as const };
		this.entries.set(path, folder);
		return folder;
	}

	async process(file: MockFile, update: (text: string) => string): Promise<void> {
		await this.beforeProcessCallback?.(file);
		const current = this.getText(file);
		const next = update(current);
		if (next !== current) {
			this.setBytes(file, encoder.encode(next));
			this.pluginWrites++;
		}
	}

	async rename(file: MockFile, path: string): Promise<void> {
		if (this.entries.has(path)) throw new Error(`Path already exists: ${path}`);
		this.entries.delete(file.path);
		file.path = path;
		this.entries.set(path, file);
	}

	async trashFile(file: MockFile): Promise<void> {
		if (this.entries.get(file.path) === file) this.entries.delete(file.path);
	}

	private setBytes(file: MockFile, bytes: Uint8Array): void {
		file.bytes = bytes.slice();
		file.stat = {
			...file.stat,
			mtime: file.stat.mtime + 1,
			size: bytes.byteLength,
		};
	}
}

export function makeApp(vault: MockVault) {
	return {
		vault,
		fileManager: { trashFile: (file: MockFile) => vault.trashFile(file) },
	};
}

export function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}
