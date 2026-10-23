// Test helper: spawn dist/src/server.js on PORT=0 (the OS picks a free port), read the real port back from the
// "listening on :<port>" line, and fail fast (with the server log) if it exits or doesn't come up.
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/server.js');
export async function startServer(env: Record<string, string | undefined>, timeoutMs = 15_000): Promise<{ srv: ChildProcess; port: number; log: () => string }> {
  const srv = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => { srv.kill(); reject(new Error(`server did not start within ${timeoutMs} ms:\n${log}`)); }, timeoutMs);
    const on = (d: Buffer) => { log += d; const m = /listening on :(\d+)/.exec(log); if (m) { clearTimeout(t); resolve(Number(m[1])); } };
    srv.stdout!.on('data', on); srv.stderr!.on('data', on);
    srv.once('exit', (code) => { clearTimeout(t); reject(new Error(`server exited (code ${code}) before listening:\n${log}`)); });
  });
  return { srv, port, log: () => log };
}
