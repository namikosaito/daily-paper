import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateArchive } from '../src/digest.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'dist');
const archive = validateArchive(JSON.parse(await readFile(path.join(root, 'data/archive.json'), 'utf8')));
const figures = new Set(archive.issues.flatMap(issue => issue.papers)
  .filter(paper => paper.figure?.status === 'available').map(paper => paper.figure.src));
for (const filename of figures) {
  if (!/^figures\/[A-Za-z0-9._-]+\.(png|jpg|webp)$/.test(filename)) throw new Error(`公開画像のパスが不正です: ${filename}`);
}
await rm(destination, { recursive: true, force: true });
await mkdir(path.join(destination, 'data'), { recursive: true });
await mkdir(path.join(destination, 'figures'), { recursive: true });
for (const filename of ['index.html', 'paper.html', 'style.css', 'app.js', 'data/archive.json', ...figures]) {
  await copyFile(path.join(root, filename), path.join(destination, filename));
}
await writeFile(path.join(destination, '.nojekyll'), '');
console.log(`公開用サイトをdistに作成しました（掲載 ${archive.issues.length}日分・画像 ${figures.size}枚）。`);
