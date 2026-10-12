import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(
	process.env.ULTISYNC_TEST_SOURCE_ROOT ?? resolve(testsDirectory, '../src'),
);
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ultisync-manager-tests-'));
const bundlePath = join(temporaryDirectory, 'managers.cjs');
const require = createRequire(import.meta.url);

await build({
	stdin: {
		contents: [
			"export { PullManager } from 'source/sync/PullManager';",
			"export { SyncManager } from 'source/sync/SyncManager';",
			"export { PushManager } from 'source/sync/PushManager';",
			"export { ChangeDetector } from 'source/sync/ChangeDetector';",
			"export { TFile } from 'obsidian';",
		].join('\n'),
		resolveDir: testsDirectory,
		sourcefile: 'manager-test-entry.ts',
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node24',
	outfile: bundlePath,
	logLevel: 'silent',
	plugins: [
		{
			name: 'test-source-and-obsidian-aliases',
			setup(buildContext) {
				buildContext.onResolve({ filter: /^source\// }, (args) => ({
					path: resolve(sourceRoot, `${args.path.slice('source/'.length)}.ts`),
				}));
				buildContext.onResolve({ filter: /^obsidian$/ }, () => ({
					path: resolve(testsDirectory, 'obsidian-mock.ts'),
				}));
			},
		},
	],
});

export const managers = require(bundlePath);

export async function cleanupManagerBundle() {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
