/** A literal shell subset. Quoting produces argv data; only unquoted operators connect commands. */
export interface LiteralReadStage { words: string[]; discardStderr: boolean; }
export interface LiteralReadPipeline { stages: LiteralReadStage[]; }
export class ReadSyntaxError extends Error {}

export function parseLiteralReadSyntax(source: string): LiteralReadPipeline[] {
  if (!source || source.length > 8192 || /[\x00-\x08\x0a-\x1f\x7f]/.test(source)) throw new ReadSyntaxError('The command is empty, too long, or contains unsupported control characters.');
  const pipelines: LiteralReadPipeline[] = [];
  let stages: LiteralReadStage[] = [];
  let stage: LiteralReadStage = { words: [], discardStderr: false };
  let word = '';
  let started = false;
  let quote: string | undefined;
  const finishWord = () => {
    if (started) { stage.words.push(word); word = ''; started = false; }
  };
  const finishStage = () => {
    finishWord();
    if (!stage.words.length) throw new ReadSyntaxError('A pipeline or command connector has an empty command.');
    stages.push(stage);
    if (stages.length > 8) throw new ReadSyntaxError('Auto supports at most eight stages per pipeline.');
    stage = { words: [], discardStderr: false };
  };
  const finishPipeline = () => {
    finishStage();
    pipelines.push({ stages });
    if (pipelines.length > 16) throw new ReadSyntaxError('Auto supports at most sixteen connected commands.');
    stages = [];
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }
    if (char === '\\') {
      const next = source[++index];
      if (next === undefined) throw new ReadSyntaxError('A trailing escape has no literal character.');
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) word += '\\';
      word += next;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === '$' || char === '`') throw new ReadSyntaxError('Variable and command expansion require permission.');
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === ' ' || char === '\t') { finishWord(); continue; }
    if (!started && source.startsWith('2>/dev/null', index) && (index + 11 === source.length || /[ \t|&]/.test(source[index + 11]!))) {
      if (stage.discardStderr) throw new ReadSyntaxError('Repeated redirections require permission.');
      stage.discardStderr = true;
      index += 10;
      continue;
    }
    if (char === '&' && source[index + 1] === '&') { finishPipeline(); index++; continue; }
    if (char === '|' && source[index + 1] !== '|') { finishStage(); continue; }
    if ('$`;&<>|(){}*?[]~#!'.includes(char)) throw new ReadSyntaxError(`Unquoted expansion or operator ${char} requires permission. Quote literal patterns and labels.`);
    word += char;
    started = true;
  }
  if (quote) throw new ReadSyntaxError('A quoted argument is not closed.');
  finishPipeline();
  return pipelines;
}
