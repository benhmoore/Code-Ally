import { expect, it, vi } from 'vitest';
import { isSensitiveConfigCommand, redactSensitiveConfigCommand } from '../configCommandPrivacy.js';
import { redactSensitiveText } from '../../utils/redaction.js';
import { logger, LogLevel } from '../../services/Logger.js';

it.each(['api_key', 'search_api_key', 'reviewer_api_key', 'API_KEY', 'api-key'])(
  'protects %s assignments with whitespace, quoted values and embedded equals', key => {
    const input = ` /CONFIG  SET ${key} = "UX-FAKE-CANARY=with=equals and spaces" `;
    expect(isSensitiveConfigCommand(input)).toBe(true);
    expect(redactSensitiveConfigCommand(input)).toContain('[REDACTED]');
    expect(redactSensitiveText(`Command: ${input}`)).not.toContain('UX-FAKE-CANARY');
    expect(isSensitiveConfigCommand(`/config set ${key} UX-FAKE-CANARY`)).toBe(true);
  }
);
it('leaves ordinary configuration commands and user messages unchanged', () => {
  for (const value of ['/config show api_key', '/config set context_size=131072', 'Discuss api_key setup']) {
    expect(isSensitiveConfigCommand(value)).toBe(false);
    expect(redactSensitiveConfigCommand(value)).toBe(value);
  }
});
it('redacts command values in both console output and buffered diagnostics', () => {
  const level = logger.getLevel(); const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    logger.setLevel(LogLevel.DEBUG);
    logger.debug('Input:', '/config set reviewer_api_key=UX-FAKE-CANARY=tail');
    logger.debug({ command: '/config set search_api_key=UX-FAKE-CANARY=tail' });
    expect(JSON.stringify(output.mock.calls)).not.toContain('UX-FAKE-CANARY');
    expect(JSON.stringify(logger.getAllLogs())).not.toContain('UX-FAKE-CANARY');
  } finally { logger.setLevel(level); output.mockRestore(); }
});
