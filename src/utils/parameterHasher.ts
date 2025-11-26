/**
 * Parameter hashing utility for duplicate detection
 *
 * Creates consistent, deterministic signatures from tool parameters,
 * handling edge cases like parameter ordering, nested objects, and arrays.
 */

/**
 * Create a consistent hash signature from tool parameters
 *
 * Edge cases handled:
 * - Parameter order independence: {a: 1, b: 2} === {b: 2, a: 1}
 * - Nested objects: Recursively sorted
 * - Arrays: Order preserved (different order = different signature)
 * - Null/undefined: Consistently represented
 *
 * @param toolName - Name of the tool
 * @param params - Tool parameters object
 * @returns Deterministic signature string
 */
export function createParameterSignature(
  toolName: string,
  params: Record<string, any>
): string {
  const normalizedParams = normalizeParams(params);
  return `${toolName}::${JSON.stringify(normalizedParams)}`;
}

/**
 * Normalize parameters for consistent comparison
 *
 * Recursively sorts object keys while preserving array order
 */
function normalizeParams(value: any): any {
  // Handle null/undefined
  if (value === null) return null;
  if (value === undefined) return null;

  // Handle arrays - preserve order, normalize elements
  if (Array.isArray(value)) {
    return value.map(normalizeParams);
  }

  // Handle objects - sort keys, normalize values
  if (typeof value === 'object') {
    const sortedKeys = Object.keys(value).sort();
    const normalized: Record<string, any> = {};

    for (const key of sortedKeys) {
      normalized[key] = normalizeParams(value[key]);
    }

    return normalized;
  }

  // Primitives: return as-is
  return value;
}
