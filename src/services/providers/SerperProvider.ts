/**
 * SerperProvider - Google Search via Serper.dev API
 *
 * Implements ISearchProvider for Serper.dev, providing Google search results
 * through their REST API with proper error handling and timeout management.
 */

import {
  ISearchProvider,
  SearchResult,
  SearchValidationResult,
  SearchProviderType,
  SerperSearchResponse,
  SEARCH_TIMEOUTS,
  SEARCH_ENDPOINTS,
} from '../../types/integration.js';
import { logger } from '../Logger.js';

export class SerperProvider implements ISearchProvider {
  readonly type: SearchProviderType = 'serper';

  /**
   * Execute a search query against Serper.dev API
   */
  async search(query: string, maxResults: number, apiKey: string): Promise<SearchResult[]> {
    logger.debug(`[SerperProvider] Searching for: "${query}" (max: ${maxResults})`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUTS.SEARCH);

    try {
      const response = await fetch(SEARCH_ENDPOINTS.SERPER, {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: query,
          num: maxResults,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw this.handleHttpError(response.status, 'Search request failed');
      }

      const data = (await response.json()) as SerperSearchResponse;
      logger.debug(`[SerperProvider] Received ${data.organic?.length ?? 0} results`);

      return this.parseResults(data);
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Serper search timed out after ${SEARCH_TIMEOUTS.SEARCH}ms`);
      }

      throw error;
    }
  }

  /**
   * Validate API key by performing a minimal test search
   */
  async validateAPIKey(apiKey: string): Promise<SearchValidationResult> {
    logger.debug('[SerperProvider] Validating API key');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUTS.VALIDATION);

    try {
      const response = await fetch(SEARCH_ENDPOINTS.SERPER, {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: 'test',
          num: 1,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 401 || response.status === 403) {
        return { valid: false, error: 'Invalid API key' };
      }

      if (response.status === 429) {
        return { valid: false, error: 'Rate limit exceeded' };
      }

      if (!response.ok) {
        return { valid: false, error: `API returned status ${response.status}` };
      }

      logger.debug('[SerperProvider] API key validated successfully');
      return { valid: true };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        return { valid: false, error: 'Validation request timed out' };
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      return { valid: false, error: `Validation failed: ${message}` };
    }
  }

  /**
   * Parse Serper API response into standardized SearchResult array
   */
  private parseResults(data: SerperSearchResponse): SearchResult[] {
    if (!data.organic || !Array.isArray(data.organic)) {
      return [];
    }

    return data.organic.map((item) => ({
      title: item.title || '',
      url: item.link || '',
      snippet: item.snippet || '',
    }));
  }

  /**
   * Create descriptive error from HTTP status code
   */
  private handleHttpError(status: number, context: string): Error {
    switch (status) {
      case 401:
      case 403:
        return new Error(`${context}: Invalid or unauthorized API key`);
      case 429:
        return new Error(`${context}: Rate limit exceeded`);
      case 400:
        return new Error(`${context}: Invalid request parameters`);
      case 500:
      case 502:
      case 503:
        return new Error(`${context}: Serper service unavailable (${status})`);
      default:
        return new Error(`${context}: HTTP ${status}`);
    }
  }
}
