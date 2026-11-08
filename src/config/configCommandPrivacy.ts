import type { Config } from '../types/index.js';
import { SECRET_CONFIG_KEYS } from './metadata.js';

/** Detect credential assignments by declared config metadata, never by value. */
function secretKey(key: string): boolean {
  return SECRET_CONFIG_KEYS.has(key.toLowerCase().replaceAll('-', '_') as keyof Config);
}

export function isSensitiveConfigCommand(input: string): boolean {
  const match = input.match(/^\s*\/config\s+set\s+([^\s=]+)(?:\s*=\s*|\s+)[\s\S]*$/i);
  return Boolean(match && secretKey(match[1]!));
}

/** Safe command echo; the original assignment still goes to ConfigManager. */
export function redactSensitiveConfigCommand(input: string): string {
  if (!isSensitiveConfigCommand(input)) return input;
  const key = input.match(/^\s*\/config\s+set\s+([^\s=]+)/i)![1]!;
  return `/config set ${key}=[REDACTED]`;
}

/** Protect command records embedded in plain-text logs and debug exports. */
export function redactSensitiveConfigCommandsInText(input: string): string {
  return input.replace(/\/config[ \t]+set[ \t]+([^\s=]+)([ \t]*=[ \t]*|[ \t]+)([^\r\n]*)/gi,
    (command: string, key: string) => secretKey(key) ? `/config set ${key}=[REDACTED]` : command);
}
