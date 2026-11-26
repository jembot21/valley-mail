/**
 * Local static server for the adjacent game/ directory; Node 22 standard library only.
 * Run: node serve.ts, then open http://localhost:8080.
 * Exports: none. GET/HEAD only, no directory listing, no access outside game/.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const gameRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), 'game'));
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function isInsideGame(path: string): boolean {
  const local = relative(gameRoot, path);
  return !isAbsolute(local) && local !== '..' && !local.startsWith('..' + sep);
}

const server = createServer(async (request, response) => {
  const reply = (status: number, message: string): void => {
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : message + '\n');
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    reply(405, 'Method not allowed');
    return;
  }
  try {
    // Decode before resolving; URL's normalisation would hide traversal segments.
    const pathname = decodeURIComponent((request.url || '/').split(/[?#]/, 1)[0]);
    if (!pathname.startsWith('/') || /[\0\\]/.test(pathname)) {
      reply(404, 'Not found');
      return;
    }
    const target = resolve(gameRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!isInsideGame(target)) {
      reply(404, 'Not found');
      return;
    }
    // A symlink inside game/ must not grant access to another directory.
    const file = await realpath(target);
    if (!isInsideGame(file) || !(await stat(file)).isFile()) {
      reply(404, 'Not found');
      return;
    }
    const bytes = await readFile(file);
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': bytes.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch {
    reply(404, 'Not found');
  }
});

server.on('error', (error) => {
  console.error('Valley Mail server: ' + error.message);
  process.exitCode = 1;
});
server.listen(8080, '127.0.0.1', () => {
  console.log('Valley Mail: http://localhost:8080');
});
