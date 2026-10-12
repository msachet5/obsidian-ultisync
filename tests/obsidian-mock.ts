export class TFile {
	path: string;
	stat: { ctime: number; mtime: number; size: number };
	bytes: Uint8Array;

	constructor(path: string, bytes: Uint8Array = new Uint8Array()) {
		this.path = path;
		this.bytes = bytes.slice();
		this.stat = { ctime: 0, mtime: 1, size: bytes.byteLength };
	}
}

export class Vault {}
export class App {}

export class Modal {
	contentEl: any;
	titleEl: any;
	constructor(_app: unknown) {}
	open(): void {}
	close(): void {}
}

export class Setting {
	constructor(_element: unknown) {}
	addButton(_configure: (button: any) => void): this {
		return this;
	}
}

export const Platform = { isWin: false };

export class Notice {
	constructor(_message: string, _duration?: number) {}
}

export async function requestUrl(): Promise<never> {
	throw new Error('The mocked manager tests must not make HTTP requests.');
}
