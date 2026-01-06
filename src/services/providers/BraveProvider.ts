/**
 * BraveProvider - Brave Search API Integration
 *
 * Implements ISearchProvider for Brave Search, providing privacy-focused
 * web search through their REST API with proper error handling and timeout management.
 */

import {
  ISearchProvider,
  SearchResult,
  SearchValidationResult,
  SearchProviderType,
  BraveSearchResponse,
  SEARCH_TIMEOUTS,
  SEARCH_ENDPOINTS,
} from '../../types/integration.js';
import { logger } from '../Logger.js';

export class BraveProvider implements ISearchProvider {
  readonly type: SearchProviderType = 'brave';

  /**
   * Maximum results per request (Brave API limit)
   */
  private static readonly MAX_RESULTS_LIMIT = 20;

  /**
   * Execute a search query against Brave Search API
   */
  async search(query: string, maxResults: number, apiKey: string): Promise<SearchResult[]> {
    const effectiveMax = Math.min(maxResults, BraveProvider.MAX_RESULTS_LIMIT);
    logger.debug(`[BraveProvider] Searching for: "${query}" (max: ${effectiveMax})`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUTS.SEARCH);

    try {
      const url = new URL(SEARCH_ENDPOINTS.BRAVE);
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(effectiveMax));

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'X-Subscription-Token': apiKey,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw this.handleHttpError(response.status, 'Search request failed');
      }

      const data = (await response.json()) as BraveSearchResponse;
      logger.debug(`[BraveProvider] Received ${data.web?.results?.length ?? 0} results`);

      return this.parseResults(data);
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Brave search timed out after ${SEARCH_TIMEOUTS.SEARCH}ms`);
      }

      throw error;
    }
  }

  /**
   * Validate API key by performing a minimal test search
   */
  async validateAPIKey(apiKey: string): Promise<SearchValidationResult> {
    logger.debug('[BraveProvider] Validating API key');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUTS.VALIDATION);

    try {
      const url = new URL(SEARCH_ENDPOINTS.BRAVE);
      url.searchParams.set('q', 'test');
      url.searchParams.set('count', '1');

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'X-Subscription-Token': apiKey,
        },
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

      logger.debug('[BraveProvider] API key validated successfully');
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
   * Parse Brave API response into standardized SearchResult array
   */
  private parseResults(data: BraveSearchResponse): SearchResult[] {
    if (!data.web?.results || !Array.isArray(data.web.results)) {
      return [];
    }

    return data.web.results.map((item) => ({
      title: item.title || '',
      url: item.url || '',
      snippet: item.description || '',
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
        return new Error(`${context}: Brave service unavailable (${status})`);
      default:
        return new Error(`${context}: HTTP ${status}`);
    }
  }
}
