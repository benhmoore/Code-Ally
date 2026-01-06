/**
 * Integration Types for External Services
 *
 * Defines types for search providers and other external service integrations.
 * Follows patterns from PluginConfigManager for encryption and validation.
 */

// ===========================
// Search Provider Types
// ===========================

/**
 * Supported search providers
 */
export type SearchProviderType = 'none' | 'brave' | 'serper';

/**
 * Individual search result from a provider
 */
export interface SearchResult {
  /** Title of the search result */
  title: string;
  /** URL to the result page */
  url: string;
  /** Text snippet/description */
  snippet: string;
}

/**
 * Integration settings for external services
 * Stored in ~/.ally/integrations.json
 */
export interface IntegrationSettings {
  /** Selected search provider */
  searchProvider: SearchProviderType;
  /** API key for the search provider (encrypted at rest) */
  searchAPIKey: string | null;
  /** Running count of searches performed (for usage tracking) */
  searchCount: number;
}

/**
 * Default integration settings
 */
export const DEFAULT_INTEGRATION_SETTINGS: IntegrationSettings = {
  searchProvider: 'none',
  searchAPIKey: null,
  searchCount: 0,
};

// ===========================
// Search Provider Interface
// ===========================

/**
 * Validation result from testing a provider configuration
 */
export interface SearchValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Provider metadata for UI display
 */
export interface SearchProviderInfo {
  /** Provider identifier */
  type: SearchProviderType;
  /** Human-readable display name */
  displayName: string;
  /** Brief description of the provider */
  description: string;
  /** Whether this provider requires an API key */
  requiresAPIKey: boolean;
  /** URL to sign up for an API key */
  signupURL?: string;
}

/**
 * Search provider metadata registry
 */
export const SEARCH_PROVIDER_INFO: Record<SearchProviderType, SearchProviderInfo> = {
  none: {
    type: 'none',
    displayName: 'None',
    description: 'No search provider configured',
    requiresAPIKey: false,
  },
  brave: {
    type: 'brave',
    displayName: 'Brave Search',
    description: 'Privacy-focused search via Brave Search API',
    requiresAPIKey: true,
    signupURL: 'https://brave.com/search/api/',
  },
  serper: {
    type: 'serper',
    displayName: 'Serper.dev',
    description: 'Google search results via Serper.dev API',
    requiresAPIKey: true,
    signupURL: 'https://serper.dev/',
  },
};

/**
 * Interface for search provider implementations
 */
export interface ISearchProvider {
  /** Provider type identifier */
  readonly type: SearchProviderType;

  /**
   * Execute a search query
   * @param query - Search query string
   * @param maxResults - Maximum number of results to return
   * @param apiKey - API key for authentication
   * @returns Array of search results
   * @throws Error on network failure or API error
   */
  search(query: string, maxResults: number, apiKey: string): Promise<SearchResult[]>;

  /**
   * Validate API key by performing a test request
   * @param apiKey - API key to validate
   * @returns Validation result with success/failure
   */
  validateAPIKey(apiKey: string): Promise<SearchValidationResult>;
}

// ===========================
// Integration Store Types
// ===========================

/**
 * Encryption configuration for integration secrets
 * Matches PLUGIN_ENCRYPTION pattern
 */
export const INTEGRATION_ENCRYPTION = {
  /** Encryption algorithm */
  ALGORITHM: 'aes-256-gcm' as const,
  /** Encryption key length in bytes (256 bits) */
  KEY_LENGTH: 32,
  /** Initialization vector length in bytes (128 bits) */
  IV_LENGTH: 16,
  /** Prefix for encrypted values */
  PREFIX: '__ENCRYPTED__',
  /** Separator for encrypted value components */
  SEPARATOR: ':',
} as const;

/**
 * Integration file paths
 */
export const INTEGRATION_FILES = {
  /** Main integration settings file */
  SETTINGS: 'integrations.json',
} as const;

// ===========================
// Search API Types
// ===========================

/**
 * Serper.dev API response structure
 */
export interface SerperSearchResponse {
  organic?: Array<{
    title: string;
    link: string;
    snippet: string;
  }>;
  searchParameters?: {
    q: string;
    num: number;
  };
}

/**
 * Brave Search API response structure
 */
export interface BraveSearchResponse {
  web?: {
    results?: Array<{
      title: string;
      url: string;
      description: string;
    }>;
  };
  query?: {
    original: string;
  };
}

// ===========================
// Network Constants
// ===========================

/**
 * Network timeouts for search operations
 */
export const SEARCH_TIMEOUTS = {
  /** Standard search request timeout (30 seconds) */
  SEARCH: 30000,
  /** Quick validation timeout (10 seconds) */
  VALIDATION: 10000,
} as const;

/**
 * API endpoints for search providers
 */
export const SEARCH_ENDPOINTS = {
  SERPER: 'https://google.serper.dev/search',
  BRAVE: 'https://api.search.brave.com/res/v1/web/search',
} as const;
