/** Fixed runner source: request data is JSON argv, never JavaScript or shell source. */
export const READ_COMMAND_RUNNER = `
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const steps = JSON.parse(process.argv[1]);
let index = 0;
async function pipeline(stages) {
  const completions = [];
  let source;
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const last = i === stages.length - 1;
    if (stage.echo !== undefined) {
      if (source) source.destroy();
      source = Readable.from([stage.echo + '\\n']);
      if (last) {
        source.pipe(process.stdout, { end: false });
        completions.push(new Promise(resolve => source.on('end', () => resolve(0))));
      } else completions.push(Promise.resolve(0));
      continue;
    }
    if (!stage.executable) { completions.push(Promise.resolve(0)); continue; }
    const child = spawn(stage.executable, stage.argv, {
      cwd: stage.workingDirectory, env: stage.environment, shell: false,
      stdio: [i ? 'pipe' : 'ignore', last ? 'inherit' : 'pipe', stage.discardStderr ? 'ignore' : 'inherit'],
    });
    if (source && child.stdin) {
      const upstream = source;
      child.stdin.on('error', error => {
        if (error.code !== 'EPIPE') process.stderr.write(error.message + '\\n');
      });
      child.stdin.on('close', () => upstream.destroy());
      upstream.pipe(child.stdin);
    }
    source = child.stdout;
    completions.push(new Promise(resolve => {
      let failed = false;
      child.on('error', error => {
        failed = true;
        if (!stage.discardStderr) process.stderr.write(error.message + '\\n');
      });
      child.on('close', code => resolve(failed ? 127 : code === null ? 128 : code));
    }));
  }
  const statuses = await Promise.all(completions);
  return statuses[statuses.length - 1];
}
async function run() {
  while (index < steps.length) {
    const status = await pipeline(steps[index++].stages);
    if (status !== 0) { process.exitCode = status; return; }
  }
}
run().catch(error => { process.stderr.write(error.message + '\\n'); process.exitCode = 127; });
`;
