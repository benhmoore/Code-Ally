# Markdown Renderer Review - Recommendations

## Priority Issues to Fix

### 1. Extract LaTeX Conversion (DRY Violation)
**Current**: LaTeX conversion duplicated in 3 places
**Fix**: Create single helper function

```typescript
/**
 * Convert LaTeX expressions to Unicode in text
 */
function processLatex(text: string): string {
  return text
    .replace(/\\\((.+?)\\\)/g, (_match, mathContent) => convertLatexToUnicode(mathContent))
    .replace(/\\\[(.+?)\\\]/g, (_match, mathContent) => convertLatexToUnicode(mathContent))
    .replace(/\$\$(.+?)\$\$/g, (_match, mathContent) => convertLatexToUnicode(mathContent));
}
```

### 2. Add Recursion Depth Limit
**Current**: `tokenizeFormatting()` has unlimited recursion
**Fix**: Add max depth parameter

```typescript
function tokenizeFormatting(text: string, depth: number = 0): StyledSegment[] {
  const MAX_DEPTH = 10;
  if (depth > MAX_DEPTH) {
    return [{ text }]; // Prevent stack overflow
  }

  // ... existing code ...

  // When recursing:
  const nested = tokenizeFormatting(match[3], depth + 1);
}
```

### 3. Consolidate Color Tag Handlers
**Current**: Separate handlers for `<red>` and `<span color="red">`
**Fix**: Single color extraction function

```typescript
function extractColorAndContent(match: RegExpMatchArray): { color: string; content: string } | null {
  // Handle both <red>text</red> and <span color="red">text</span>
  if (match[2] && match[3]) {
    return { color: match[2], content: match[3] };
  }
  if (match[4] && match[5]) {
    return { color: match[4], content: match[5] };
  }
  return null;
}
```

### 4. Add Table Validation
**Current**: No validation for edge cases
**Fix**: Add validation before rendering

```typescript
// In TableRenderer component
if (!header || header.length === 0) {
  return <Text dimColor>Empty table</Text>;
}

// Validate all rows have same column count
const expectedCols = header.length;
const validRows = rows.filter(row => row.length === expectedCols);
if (validRows.length < rows.length) {
  logger.warn(`Table has ${rows.length - validRows.length} rows with mismatched columns`);
}
```

### 5. Add Safe Thinking Duration Calculation
**Current**: No null check before calculating duration
**Fix**: Add guard

```typescript
// Line 70-72 in MessageDisplay.tsx
message.thinkingStartTime && message.thinkingEndTime
  ? `∴ Thought for ${formatDuration(message.thinkingEndTime - message.thinkingStartTime)}`
  : '∴ Thought'
```
**Status**: ✅ Already correct!

### 6. Simplify Regex (Long-term)
**Current**: Single massive regex for all formatting
**Recommendation**: Consider migration to proper markdown parser or split into phases

**Option A**: Multiple passes (clearer but slower)
```typescript
// Pass 1: Extract code blocks (protect from other parsing)
// Pass 2: Parse colors
// Pass 3: Parse bold/italic/strikethrough
```

**Option B**: Use existing markdown library features more
```typescript
// Use marked's inline tokenizer instead of custom regex
```

## Non-Critical Improvements

### 7. Add Code Block Language Fallback
```typescript
// Line 209 - Improve language detection
const language = node.language || detectLanguageFromContent(node.content);
```

### 8. Table Column Width Constants
Move magic numbers to constants:
```typescript
const TABLE_CONFIG = {
  MIN_COLUMN_WIDTH: 8,      // Line 426
  DEFAULT_MIN_WIDTH: 10,    // Line 420
  WORD_BOUNDARY_RATIO: 0.6, // From TEXT_LIMITS.WORD_BOUNDARY_THRESHOLD
};
```

### 9. Add Unit Tests
Missing test coverage for:
- Edge cases in formatInlineMarkdown
- Table rendering with extreme widths
- Nested formatting depth
- LaTeX conversion
- Malformed markdown

### 10. Performance Profiling
Current areas that might benefit from optimization:
- Table width calculation (useMemo already present ✓)
- Large code blocks with syntax highlighting
- Very long messages with heavy formatting

## Security Considerations

### ✅ Already Secure
- No HTML rendering (text-only)
- No eval() or code execution
- Safe regex (no catastrophic backtracking detected)

### Potential Improvements
1. **Limit message length**: Add max length truncation for safety
2. **Sanitize URLs**: Even though not clickable, validate URL formats
3. **Limit table size**: Cap maximum rows/columns to prevent memory issues

## Summary

**Overall Assessment**: The renderer is **robust and well-designed** with good error handling and performance optimizations.

**Priority Fixes** (Recommended):
1. ✅ HIGH: Extract LaTeX conversion to eliminate duplication
2. ✅ HIGH: Add recursion depth limit to prevent stack overflow
3. ⚠️  MEDIUM: Consolidate color tag handlers
4. ⚠️  MEDIUM: Add table validation
5. ⚠️  LOW: Add unit tests for edge cases

**Breaking Changes**: None required - all improvements are backwards compatible.
