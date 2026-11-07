/** Read utility argument effects. File operands are validated separately against the workspace. */
export interface ReadUtilitySyntax { program: string; flags: string[]; paths: string[]; metadata?: boolean; expression?: string[]; }
export function parseReadUtility(words: readonly string[], inputFromPipe: boolean): ReadUtilitySyntax | null {
  const name = words[0]!;
  const program = name.slice(name.lastIndexOf('/') + 1);
  if (name !== program && name !== `/bin/${program}` && name !== `/usr/bin/${program}`) return null;
  if (program === 'find') return parseFind(words.slice(1));
  if (program === 'sort' || program === 'uniq') return parseTransform(program, words.slice(1), inputFromPipe);
  if (!['pwd', 'ls', 'cat', 'head', 'tail', 'wc'].includes(program)) return null;
  const flags: string[] = [];
  const paths: string[] = [];
  let operands = false;
  for (let index = 1; index < words.length; index++) {
    const word = words[index]!;
    if (!operands && word === '--') { operands = true; continue; }
    if (!operands && word.startsWith('-') && word !== '-') {
      if (program === 'head' || program === 'tail') {
        const count = word === '-n' ? words[++index] : /^-n\d+$/.test(word) ? word.slice(2) : undefined;
        if (!count || !/^\d+$/.test(count) || Number(count) < 1 || Number(count) > 10000 || flags.length) return null;
        flags.push('-n', String(Number(count)));
      } else {
        const allowed = program === 'pwd' ? /^-P$/ : program === 'ls' ? /^-[laAh1dFptrS]+$/ : program === 'cat' ? /^-[nbsevt]+$/ : /^-[lwc]+$/;
        if (!allowed.test(word)) return null;
        flags.push(word);
      }
    } else paths.push(word);
  }
  if (program === 'pwd') return paths.length ? null : { program, flags, paths: [], metadata: true };
  if (!paths.length && program === 'ls') paths.push('.');
  if (!paths.length && !inputFromPipe) return null;
  if (paths.length > 32 || paths.some(value => !value || (value === '-' && !inputFromPipe))) return null;
  return { program, flags, paths, metadata: program === 'ls' };
}

function parseTransform(program: 'sort' | 'uniq', words: readonly string[], inputFromPipe: boolean): ReadUtilitySyntax | null {
  if (!inputFromPipe) return null;
  const flags: string[] = [];
  const longFlags = new Set(['--reverse', '--numeric-sort', '--unique', '--ignore-case', '--ignore-leading-blanks', '--dictionary-order', '--check', '--stable']);
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (word === '--' && index === words.length - 1) continue;
    if ((program === 'sort' && (/^-[rnufbdiMghVcsC]+$/.test(word) || longFlags.has(word)))
      || (program === 'uniq' && /^-[cdui]+$/.test(word))) { flags.push(word); continue; }
    if (program === 'sort' && (word === '-k' || word.startsWith('--key=') || /^-k.+/.test(word))) {
      const value = word === '-k' ? words[++index] : word.startsWith('--key=') ? word.slice(6) : word.slice(2);
      if (!value || !/^\d+(?:\.\d+)?[bdfghiMnrV]*(?:,\d+(?:\.\d+)?[bdfghiMnrV]*)?$/.test(value)) return null;
      flags.push('-k', value); continue;
    }
    if (program === 'sort' && (word === '-t' || word.startsWith('--field-separator='))) {
      const value = word === '-t' ? words[++index] : word.slice(18);
      if (!value || [...value].length !== 1) return null;
      flags.push('-t', value); continue;
    }
    if (program === 'uniq' && /^-[fsw]\d+$/.test(word)) { flags.push(word); continue; }
    return null; // File inputs, output files, temporary directories and external compressors are not stdin transforms.
  }
  return { program, flags, paths: [] };
}

function parseFind(words: readonly string[]): ReadUtilitySyntax | null {
  const paths: string[] = [];
  let index = 0;
  if (words[index] === '-P') index++;
  while (index < words.length && !words[index]!.startsWith('-') && !['!', '('].includes(words[index]!)) paths.push(words[index++]!);
  if (!paths.length) paths.push('.');
  if (paths.length > 16 || paths.some(value => !value)) return null;
  const expression = words.slice(index);
  let cursor = 0;
  const zero = new Set(['-print', '-print0', '-empty', '-depth', '-xdev', '-mount', '-prune', '-true', '-false']);
  function primary(): boolean {
    const word = expression[cursor++];
    if (word === '!' || word === '-not') return primary();
    if (word === '(') {
      if (!or()) return false;
      return expression[cursor++] === ')';
    }
    if (!word) return false;
    if (zero.has(word)) return true;
    const value = expression[cursor++];
    if (value === undefined) return false;
    if (['-name', '-iname', '-path', '-ipath'].includes(word)) return true;
    if (word === '-type') return /^[bcdflps]$/.test(value);
    if (word === '-maxdepth' || word === '-mindepth') return /^\d{1,4}$/.test(value) && Number(value) <= 1000;
    if (['-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-uid', '-gid', '-links'].includes(word)) return /^[+-]?\d{1,9}$/.test(value);
    if (word === '-size') return /^[+-]?\d{1,9}[bcwkMG]?$/.test(value);
    return false;
  }
  function and(): boolean {
    if (!primary()) return false;
    while (cursor < expression.length && ![')', '-o', '-or'].includes(expression[cursor]!)) {
      if (expression[cursor] === '-a' || expression[cursor] === '-and') cursor++;
      if (!primary()) return false;
    }
    return true;
  }
  function or(): boolean {
    if (!and()) return false;
    while (expression[cursor] === '-o' || expression[cursor] === '-or') {
      cursor++;
      if (!and()) return false;
    }
    return true;
  }
  if (expression.length && (!or() || cursor !== expression.length)) return null;
  return { program: 'find', flags: ['-P'], paths, metadata: true, expression: [...expression] };
}
