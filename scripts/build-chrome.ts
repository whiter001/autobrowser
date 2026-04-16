import { copyFile, rm } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const extensionDir = path.join(rootDir, 'extension');
const outputDir = path.join(rootDir, 'chrome');

await rm(outputDir, { recursive: true, force: true });

const build = await Bun.build({
  entrypoints: [
    path.join(extensionDir, 'background.ts'),
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
await copyFile(path.join(extensionDir, 'options.html'), path.join(outputDir, 'options.html'));
