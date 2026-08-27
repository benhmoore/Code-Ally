/**
 * Extract literal absolute filesystem paths from shell source without executing
 * or expanding it. Dynamic expansion is deliberately rejected: authorization
 * can only be established for paths that are known before execution.
 */
export interface ShellPathAnalysis {
  absolutePaths: string[];
  hasParentTraversal: boolean;
  hasUnresolvedExpansion: boolean;
}

export function analyzeShellCommandPaths(command: string): ShellPathAnalysis {
  if (/\0|\$\(|`|\$\{|\$HOME|~\//.test(command)) {
    return { absolutePaths: [], hasParentTraversal: false, hasUnresolvedExpansion: true };
  }

  const words: string[] = [];
  let word = '';
  let quote: 'single' | 'double' | null = null;
  let escaped = false;

  const finishWord = () => {
    if (word) words.push(word);
    word = '';
  };

  for (const char of command) {
    if (escaped) {
      word += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== 'single') {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
      continue;
    }
    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      continue;
    }
    if (quote === null && (/\s/.test(char) || '|&;<>()[]{}'.includes(char))) {
      finishWord();
      continue;
    }
    word += char;
  }

  if (quote !== null || escaped) {
    return { absolutePaths: [], hasParentTraversal: false, hasUnresolvedExpansion: true };
  }
  finishWord();

  const paths = new Set<string>();
  let hasParentTraversal = false;
  for (const shellWord of words) {
    const value = shellWord.includes('=') ? shellWord.slice(shellWord.indexOf('=') + 1) : shellWord;
    if (value.split('/').includes('..')) hasParentTraversal = true;
    if (!value.startsWith('/')) continue;
    const wildcard = value.search(/[?*[]/);
    const candidate = wildcard === -1 ? value : value.slice(0, wildcard);
    if (candidate) paths.add(candidate.endsWith('/') && candidate.length > 1 ? candidate.slice(0, -1) : candidate);
  }
  return {
    absolutePaths: [...paths],
    hasParentTraversal,
    hasUnresolvedExpansion: false,
  };
}
