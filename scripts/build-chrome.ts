import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EXTENSION_PUBLIC_KEY } from '../src/core/extension.js';

const rootDir = process.cwd();
const extensionDir = path.join(rootDir, 'extension');
const outputDir = path.join(rootDir, 'chrome');

await rm(outputDir, { recursive: true, force: true });

const build = await Bun.build({
  entrypoints: [
    path.join(extensionDir, 'background.ts'),
    path.join(extensionDir, 'connect.ts'),
    path.join(extensionDir, 'options.ts'),
  ],
  outdir: outputDir,
  target: 'browser',
});

if (!build.success) {
  console.error(build.logs);
  process.exit(1);
}

await copyFile(path.join(extensionDir, 'manifest.json'), path.join(outputDir, 'manifest.json'));
const manifestPath = path.join(outputDir, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
manifest.key = EXTENSION_PUBLIC_KEY;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
await copyFile(path.join(extensionDir, 'connect.html'), path.join(outputDir, 'connect.html'));
await copyFile(path.join(extensionDir, 'options.html'), path.join(outputDir, 'options.html'));
