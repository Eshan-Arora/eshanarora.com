import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import chokidar from 'chokidar';

const port = Number(process.env.PORT || 8788);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const addresses = Object.entries(networkInterfaces())
  .filter(([name]) => !/^(utun|ipsec|awdl|llw)/.test(name))
  .flatMap(([, entries]) => entries || [])
  .filter(entry => entry.family === 'IPv4' && !entry.internal)
  .map(entry => entry.address);
const origin = `http://${addresses[0] || 'localhost'}:${port}`;
const env = {
  ...process.env,
  PUBLIC_VOTE_URL: `${origin}/vote`,
  WRANGLER_LOG_PATH: resolve('.wrangler/dev.log'),
  // Local development needs no Cloudflare account or global config writes.
  XDG_CONFIG_HOME: resolve('.wrangler/config'),
  WRANGLER_SEND_METRICS: 'false',
  CHOKIDAR_USEPOLLING: 'true',
};
const astro = resolve('node_modules/astro/bin/astro.mjs');
const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
const children = new Set();
let watcher;
let stopping = false;
let timer;
function launch(file, args) {
  const child = spawn(process.execPath, [file, ...args], { stdio: 'inherit', env });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}
function run(file, args) {
  return new Promise((resolveRun, reject) => {
    const child = launch(file, args);
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${args.join(' ')} failed (${code})`)));
  });
}
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  await watcher?.close();
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

try {
  await mkdir('.wrangler', { recursive: true });
  await run(wrangler, ['d1', 'migrations', 'apply', 'VOTES', '--local']);
  await run(astro, ['build']);
  if (!stopping) {
    let building = false;
    let pending = false;
    async function rebuild() {
      if (stopping) return;
      if (building) { pending = true; return; }
      building = true;
      try { await run(astro, ['build']); }
      catch (error) { if (!stopping) console.error(error.message); }
      finally { building = false; if (pending) { pending = false; void rebuild(); } }
    }
    watcher = chokidar.watch(['src', 'public', 'astro.config.mjs'], { ignoreInitial: true, usePolling: true, interval: 500 });
    watcher.on('all', () => { clearTimeout(timer); timer = setTimeout(() => void rebuild(), 200); });
    watcher.on('error', error => { console.error(error); void stop(1); });
    const server = launch(wrangler, ['pages', 'dev', 'dist', '--ip', '0.0.0.0', '--port', String(port), '--live-reload']);
    server.once('error', error => { console.error(error); void stop(1); });
    server.once('exit', code => void stop(code || 0));
    console.log(`\nVoting: ${origin}/vote\nAdmin:  ${origin}/vote/admin\nWatching source files; changes rebuild automatically.\n`);
  }
} catch (error) {
  if (!stopping) { console.error(error.message); await stop(1); }
}
