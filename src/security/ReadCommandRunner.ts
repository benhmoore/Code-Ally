/** Fixed runner source: request data is passed separately as JSON argv, never evaluated. */
export const READ_COMMAND_RUNNER = `
const { spawn } = require('node:child_process');
const steps = JSON.parse(process.argv[1]);
let index = 0;
function next() {
  const step = steps[index++];
  if (!step) return;
  if (step.echo !== undefined) {
    process.stdout.write(step.echo + '\\n', next);
    return;
  }
  if (!step.executable) { next(); return; }
  const child = spawn(step.executable, step.argv, {
    cwd: step.workingDirectory,
    env: step.environment,
    shell: false,
    stdio: ['ignore', 'inherit', step.discardStderr ? 'ignore' : 'inherit'],
  });
  child.on('error', error => {
    if (!step.discardStderr) process.stderr.write(error.message + '\\n');
    process.exitCode = 127;
  });
  child.on('close', (code) => {
    if (code === 0) next();
    else process.exitCode = code === null ? 128 : code;
  });
}
next();
`;
