/**
 * Build the HTTP headers for an LLM request. Shared by every ModelClient so the
 * auth/header merge rule lives in exactly one place.
 *
 * Precedence: explicit `headers` win, then a bearer token derived from `apiKey`
 * (only when the caller hasn't already supplied an Authorization header), then
 * the JSON content type. This lets local Ollama run header-free while cloud /
 * remote OpenAI-compatible endpoints authenticate with a key.
 */
export function buildRequestHeaders(opts: {
  apiKey?: string;
  headers?: Record<string, string>;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers ?? {}),
  };

  const hasAuth = Object.keys(headers).some(k => k.toLowerCase() === 'authorization');
  if (opts.apiKey && !hasAuth) {
    headers['Authorization'] = `Bearer ${opts.apiKey}`;
  }

  return headers;
}
