import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

// Nest's constructor and DTO metadata must come from the TypeScript compiler.
// Restart only after a complete successful emission, never half-built output.
const require = createRequire(import.meta.url);
const compilerPath = require.resolve('typescript/bin/tsc');
const successMessage = 'Found 0 errors. Watching for file changes.';
const serverPath = 'dist/src/main.js';
const signal = 'SIGTERM';
const compiler = spawn(process.execPath, [compilerPath, '--watch', '--preserveWatchOutput', '--pretty', 'false', '--locale', 'en', '-p', 'tsconfig.build.json'], { stdio: ['ignore', 'pipe', 'inherit'] });
let server;
let stopping = false;
let restart = Promise.resolve();
let pending = String();

function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => { child.once('exit', resolve); child.kill(signal); });
}
compiler.stdout.on('data', chunk => {
  process.stdout.write(chunk);
  pending += chunk.toString();
  if (!pending.includes(successMessage)) return;
  pending = String();
  restart = restart.then(async () => {
    await stop(server);
    if (!stopping) server = spawn(process.execPath, [serverPath], { stdio: 'inherit', env: process.env });
  });
});
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await stop(server);
  await stop(compiler);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
compiler.once('exit', async code => { await shutdown(); process.exitCode = code ?? 0; });
