import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(projectRoot, 'apps', 'review', 'src');
const outputRoot = path.join(projectRoot, 'apps', 'agent', 'review-web');

await fs.rm(outputRoot, { recursive: true, force: true });
await fs.mkdir(outputRoot, { recursive: true });
await Promise.all([
  esbuild.build({
    entryPoints: [path.join(sourceRoot, 'app.js')],
    bundle: true,
    minify: true,
    sourcemap: false,
    format: 'esm',
    target: ['chrome120'],
    outfile: path.join(outputRoot, 'app.js'),
    loader: { '.ttf': 'dataurl' },
  }),
  esbuild.build({
    entryPoints: [path.join(projectRoot, 'node_modules', 'monaco-editor', 'esm', 'vs', 'editor', 'editor.worker.js')],
    bundle: true,
    minify: true,
    format: 'esm',
    target: ['chrome120'],
    outfile: path.join(outputRoot, 'editor.worker.js'),
  }),
  fs.copyFile(path.join(sourceRoot, 'index.html'), path.join(outputRoot, 'index.html')),
]);
console.log(`[review-web] ${outputRoot}`);
