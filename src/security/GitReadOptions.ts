/** Option families, not shell snippets: every accepted token has a known read-only meaning. */
export interface GitReadOperation {
  family: 'log' | 'status' | 'remote' | 'diff' | 'branch';
  argv: string[];
  workingTree: boolean;
}

const FLAGS: Record<GitReadOperation['family'], ReadonlySet<string>> = {
  log: new Set(['--oneline', '--graph', '--all', '--no-merges', '--merges', '--first-parent', '--reverse', '--no-decorate']),
  status: new Set(['--short', '--branch', '--long', '--porcelain', '--ahead-behind', '--no-ahead-behind', '--show-stash', '--untracked-files', '-u']),
  remote: new Set(['-v', '--verbose']),
  diff: new Set(['--patch', '-p', '--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '--summary', '--cached', '--staged', '--exit-code', '--quiet']),
  branch: new Set(['--list', '--all', '--remotes', '--show-current', '--verbose', '-v', '-vv']),
};
const MAX_LOG_COUNT = 9999;

export function parseGitReadOptions(input: readonly string[]): GitReadOperation | null {
  const words = [...input];
  while (words[0] === '--no-pager' || words[0] === '--no-optional-locks') words.shift();
  const family = words.shift() as GitReadOperation['family'];
  if (!Object.hasOwn(FLAGS, family)) return null;
  const argv: string[] = [];
  let count: number | undefined;
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (word === '--' && index === words.length - 1) continue;
    if (family === 'log' && (word === '-n' || word === '--max-count' || /^-\d+$/.test(word) || /^-n\d+$/.test(word) || word.startsWith('--max-count='))) {
      const value = word === '-n' || word === '--max-count' ? words[++index]
        : word.startsWith('--max-count=') ? word.slice('--max-count='.length)
          : word.startsWith('-n') ? word.slice(2) : word.slice(1);
      if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_LOG_COUNT || count !== undefined) return null;
      count = Number(value);
      continue;
    }
    if (FLAGS[family].has(word)) { argv.push(word); continue; }
    if (family === 'status' && (/^-[sb]+$/.test(word) || /^-u(?:no|normal|all)$/.test(word)
      || /^--porcelain=(?:v?[12])$/.test(word) || /^--untracked-files=(?:no|normal|all)$/.test(word))) {
      argv.push(word);
      continue;
    }
    if (family === 'branch' && /^-[ar]+$/.test(word)) { argv.push(word); continue; }
    return null;
  }
  // Listing remote names without -v is read-only too; no remote mutation subcommands are admitted.
  if (family === 'log') argv.push(`--max-count=${count ?? 50}`);
  return { family, argv, workingTree: family === 'status' || family === 'diff' };
}
