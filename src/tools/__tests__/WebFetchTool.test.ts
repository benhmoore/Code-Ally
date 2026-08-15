import { describe, expect, it } from 'vitest';
import { WebFetchTool } from '../WebFetchTool.js';
import { ActivityStream } from '../../services/ActivityStream.js';

describe('WebFetchTool network boundary', () => {
  const tool = new WebFetchTool(new ActivityStream());

  it.each([
    'http://127.0.0.1/admin',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1/private',
    'http://100.64.0.1/private',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://user:password@example.com/',
  ])('blocks private and metadata URL %s', async (url) => {
    const result = await tool.execute({ url });
    expect(result.success).toBe(false);
    expect(result.error_type).toBe('security_error');
  });
});
