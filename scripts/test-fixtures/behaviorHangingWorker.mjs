// Disposable offline process fixture. Never creates model/network requests.
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
await writeFile(config.output, JSON.stringify({ passed: true, metrics: {}, requests: [] }));
const mode = process.argv[3];
async function acknowledge() {
  if (process.connected)
    await new Promise(resolve => process.send({ type: 'behavior-worker-cleanup-complete' }, resolve));
  if (process.connected) process.disconnect();
}
if (mode === 'descendant') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await writeFile(join(config.workspace, 'descendant.pid'), String(child.pid));
  process.exit(0);
}
if (mode === 'finish') {
  await acknowledge();
  process.exit(0);
}
if (mode === 'finish-later') setTimeout(() => process.exit(0), 200);
if (mode === 'detached' || mode === 'detached-no-cleanup') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  await writeFile(join(config.workspace, 'descendant.pid'), String(child.pid));
  process.on('message', async message => {
    if (message?.type !== 'behavior-worker-stop') return;
    process.send?.({ type: 'behavior-worker-stopping', ownedProcesses: [{ id: 'detached-fixture', pid: child.pid }] });
    if (mode === 'detached-no-cleanup') return;
    const closed = new Promise(resolve => child.once('close', resolve));
    child.kill('SIGKILL');
    await closed;
    await acknowledge();
    process.exit(124);
  });
}
setInterval(() => {}, 1000);
