import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const allowed = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/paper.html', ['paper.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/data/archive.json', ['data/archive.json', 'application/json; charset=utf-8']],
  ['/data/preview.json', ['data/preview.json', 'application/json; charset=utf-8']],
]);
const port = Number(process.env.PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT が不正です。');
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const image = pathname.match(/^\/figures\/([A-Za-z0-9._-]+)\.(png|jpg|webp)$/);
  const imageTypes = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
  const entry = allowed.get(pathname) ?? (image ? [pathname.slice(1), imageTypes[image[2]]] : null);
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  if (!entry) {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    const data = await readFile(path.join(root, entry[0]));
    response.writeHead(200, {
      'Content-Type': entry[1], 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      response.writeHead(404).end('Not found');
    } else {
      console.error(`配信エラー: ${pathname}`, error);
      response.writeHead(500).end('Internal server error');
    }
  }
});
server.on('error', error => {
  console.error(`サーバーを起動できません: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log(`Physical AI Daily: http://localhost:${port}`));
