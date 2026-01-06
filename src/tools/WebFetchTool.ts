/**
 * WebFetchTool - Fetch and extract text content from URLs
 *
 * Provides URL fetching with HTML-to-text conversion, timeout handling,
 * and content type validation.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { TOOL_OUTPUT_ESTIMATES } from '../config/toolDefaults.js';

const DEFAULT_MAX_LENGTH = 50000;
const FETCH_TIMEOUT_MS = 30000;

const ALLOWED_CONTENT_TYPES = [
  'text/html',
  'text/plain',
  'application/json',
  'application/xml',
  'text/xml',
];

export class WebFetchTool extends BaseTool {
  readonly name = 'web-fetch';
  readonly displayName = 'Fetch URL';
  readonly description =
    'Fetch and extract text content from a URL. Supports HTML, plain text, and JSON. HTML is converted to readable text.';
  readonly requiresConfirmation = false; // Read-only operation
  readonly isExploratoryTool = true;

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Provide custom function definition
   */
  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The URL to fetch content from',
            },
            max_length: {
              type: 'integer',
              description: `Maximum content length to return (default: ${DEFAULT_MAX_LENGTH})`,
            },
          },
          required: ['url'],
        },
      },
    };
  }

  /**
   * Validate URL format
   */
  private validateUrl(url: string): { valid: boolean; error?: string } {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { valid: false, error: 'URL must use http or https protocol' };
      }
      return { valid: true };
    } catch {
      return { valid: false, error: 'Invalid URL format' };
    }
  }

  /**
   * Check if content type is allowed
   */
  private isAllowedContentType(contentType: string | null): boolean {
    if (!contentType) return false;
    const mimeType = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    return ALLOWED_CONTENT_TYPES.some(allowed => mimeType.startsWith(allowed));
  }

  /**
   * Extract readable text from HTML content
   * Removes scripts, styles, and non-content elements
   */
  private extractTextFromHtml(html: string): string {
    let text = html;

    // Remove script tags and their content
    text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

    // Remove style tags and their content
    text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

    // Remove nav, header, footer tags and their content
    text = text.replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '');
    text = text.replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, '');
    text = text.replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '');

    // Remove noscript tags and their content
    text = text.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '');

    // Remove HTML comments
    text = text.replace(/<!--[\s\S]*?-->/g, '');

    // Try to extract just the body content if present
    const bodyMatch = text.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (bodyMatch && bodyMatch[1]) {
      text = bodyMatch[1];
    }

    // Replace block-level elements with newlines for better readability
    text = text.replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, '\n');
    text = text.replace(/<(br|hr)\s*\/?>/gi, '\n');

    // Replace list items with bullet points
    text = text.replace(/<li[^>]*>/gi, '- ');

    // Remove all remaining HTML tags
    text = text.replace(/<[^>]+>/g, ' ');

    // Decode common HTML entities
    text = text.replace(/&nbsp;/gi, ' ');
    text = text.replace(/&amp;/gi, '&');
    text = text.replace(/&lt;/gi, '<');
    text = text.replace(/&gt;/gi, '>');
    text = text.replace(/&quot;/gi, '"');
    text = text.replace(/&#39;/gi, "'");
    text = text.replace(/&#x27;/gi, "'");
    text = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
    text = text.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));

    // Collapse multiple whitespace to single space
    text = text.replace(/[ \t]+/g, ' ');

    // Collapse multiple newlines to max two
    text = text.replace(/\n{3,}/g, '\n\n');

    // Trim each line
    text = text.split('\n').map(line => line.trim()).join('\n');

    // Final trim
    text = text.trim();

    return text;
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const url = args.url as string;
    const maxLength = Math.min(
      Number(args.max_length) || DEFAULT_MAX_LENGTH,
      DEFAULT_MAX_LENGTH * 2
    );

    if (!url) {
      return this.formatErrorResponse(
        'url parameter is required',
        'validation_error',
        'Example: web-fetch(url="https://example.com")'
      );
    }

    // Validate URL format
    const urlValidation = this.validateUrl(url);
    if (!urlValidation.valid) {
      return this.formatErrorResponse(
        urlValidation.error!,
        'validation_error',
        'Provide a valid http or https URL'
      );
    }

    try {
      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; CodeAlly/1.0)',
            'Accept': 'text/html,text/plain,application/json,*/*',
          },
        });
      } finally {
        clearTimeout(timeoutId);
      }

      // Handle HTTP errors
      if (!response.ok) {
        const statusMessages: Record<number, string> = {
          400: 'Bad request',
          401: 'Authentication required',
          403: 'Access forbidden',
          404: 'Page not found',
          429: 'Rate limited',
          500: 'Server error',
          502: 'Bad gateway',
          503: 'Service unavailable',
          504: 'Gateway timeout',
        };

        const message = statusMessages[response.status] || `HTTP error ${response.status}`;
        return this.formatErrorResponse(
          `${message} (${response.status})`,
          'system_error',
          response.status === 404 ? 'Check that the URL is correct' : undefined
        );
      }

      // Validate content type
      const contentType = response.headers.get('content-type');
      if (!this.isAllowedContentType(contentType)) {
        return this.formatErrorResponse(
          `Unsupported content type: ${contentType || 'unknown'}`,
          'validation_error',
          'Only text/html, text/plain, and application/json are supported'
        );
      }

      // Read response body
      const rawContent = await response.text();

      // Process content based on type
      let content: string;
      const mimeType = (contentType?.split(';')[0]?.trim().toLowerCase()) ?? '';

      if (mimeType.includes('json')) {
        // For JSON, pretty-print it
        try {
          const parsed = JSON.parse(rawContent);
          content = JSON.stringify(parsed, null, 2);
        } catch {
          content = rawContent;
        }
      } else if (mimeType.includes('html')) {
        // Extract text from HTML
        content = this.extractTextFromHtml(rawContent);
      } else {
        // Plain text - use as-is
        content = rawContent;
      }

      // Truncate if needed
      const truncated = content.length > maxLength;
      if (truncated) {
        content = content.substring(0, maxLength) + '\n\n[Content truncated]';
      }

      return this.formatSuccessResponse({
        content,
        url,
        content_type: mimeType,
        content_length: content.length,
        truncated,
      });

    } catch (error) {
      // Handle specific error types
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          return this.formatErrorResponse(
            `Request timed out after ${FETCH_TIMEOUT_MS / 1000} seconds`,
            'system_error',
            'The server took too long to respond'
          );
        }

        if (error.message.includes('ENOTFOUND') || error.message.includes('getaddrinfo')) {
          return this.formatErrorResponse(
            'Could not resolve hostname',
            'system_error',
            'Check that the domain name is correct'
          );
        }

        if (error.message.includes('ECONNREFUSED')) {
          return this.formatErrorResponse(
            'Connection refused',
            'system_error',
            'The server refused the connection'
          );
        }

        if (error.message.includes('ECONNRESET')) {
          return this.formatErrorResponse(
            'Connection reset by server',
            'system_error',
            'Try again or check if the URL is accessible'
          );
        }

        if (error.message.includes('certificate') || error.message.includes('SSL')) {
          return this.formatErrorResponse(
            'SSL/TLS certificate error',
            'system_error',
            'The server has an invalid or expired certificate'
          );
        }
      }

      return this.formatErrorResponse(
        `Failed to fetch URL: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'system_error'
      );
    }
  }

  /**
   * Format subtext for display in UI
   */
  formatSubtext(args: Record<string, any>, _result?: any): string | null {
    const url = args.url as string;
    const description = args.description as string;

    if (!url) return null;

    try {
      const parsed = new URL(url);
      const host = parsed.hostname;
      const path = parsed.pathname.length > 30
        ? parsed.pathname.substring(0, 27) + '...'
        : parsed.pathname;

      const urlInfo = path === '/' ? host : `${host}${path}`;

      if (description) {
        return `${description} (${urlInfo})`;
      }
      return urlInfo;
    } catch {
      return description || url;
    }
  }

  /**
   * Get parameters shown in subtext
   */
  getSubtextParameters(): string[] {
    return ['url', 'description'];
  }

  /**
   * Get truncation guidance
   */
  getTruncationGuidance(): string {
    return 'Use max_length parameter to limit content size, or extract specific sections from the response';
  }

  /**
   * Get estimated output size
   */
  getEstimatedOutputSize(): number {
    return TOOL_OUTPUT_ESTIMATES.READ;
  }

  /**
   * Custom result preview
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const lines: string[] = [];
    const contentType = result.content_type as string;
    const contentLength = result.content_length as number;
    const truncated = result.truncated as boolean;

    let summary = `Fetched ${contentLength} chars`;
    if (contentType) {
      summary += ` (${contentType})`;
    }
    if (truncated) {
      summary += ' [truncated]';
    }
    lines.push(summary);

    // Show first few lines of content
    if (result.content) {
      const contentLines = (result.content as string).split('\n')
        .filter((line: string) => line.trim())
        .slice(0, maxLines - 1);
      for (const line of contentLines) {
        const trimmed = line.length > 80 ? line.substring(0, 77) + '...' : line;
        lines.push(trimmed);
      }
    }

    return lines;
  }
}
