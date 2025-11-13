# UI Styling Reference

Centralized UI constants, utilities, and components for consistent terminal display.

## Quick Reference

All UI components use centralized constants from:
- `src/config/uiSymbols.ts` - Unicode symbols
- `src/config/constants.ts` - Dimensions and limits
- `src/ui/utils/` - Helper functions
- `src/ui/components/` - Reusable components

## Constants

### UI Symbols

Location: `src/config/uiSymbols.ts`

```typescript
import { UI_SYMBOLS } from '@config/uiSymbols.js';

// Status
UI_SYMBOLS.STATUS.SUCCESS      // ✓
UI_SYMBOLS.STATUS.ERROR        // ✕
UI_SYMBOLS.STATUS.CANCELLED    // ⊘
UI_SYMBOLS.STATUS.PENDING      // ○
UI_SYMBOLS.STATUS.EXECUTING    // ●

// Navigation
UI_SYMBOLS.NAVIGATION.ARROW_RIGHT    // →
UI_SYMBOLS.NAVIGATION.CHEVRON_RIGHT  // >
UI_SYMBOLS.NAVIGATION.THEREFORE      // ∴

// Todo
UI_SYMBOLS.TODO.CHECKED     // ☑
UI_SYMBOLS.TODO.UNCHECKED   // ☐
UI_SYMBOLS.TODO.PROPOSED    // ◯

// Borders
UI_SYMBOLS.BORDER.HORIZONTAL  // ─
UI_SYMBOLS.BORDER.VERTICAL    // │

// Separators
UI_SYMBOLS.SEPARATOR.BULLET      // •
UI_SYMBOLS.SEPARATOR.MIDDLE_DOT  // ·
```

### Text Limits

Location: `src/config/constants.ts`

```typescript
import { TEXT_LIMITS } from '@config/constants.js';

TEXT_LIMITS.MAX_CONTENT_WIDTH      // 200 columns (readability cap)
TEXT_LIMITS.DIVIDER_MIN_WIDTH      // 60 columns minimum
TEXT_LIMITS.DIVIDER_PADDING        // 4 columns padding
TEXT_LIMITS.CONTENT_PREVIEW_MAX    // 200 chars
```

## Utilities

### uiHelpers.ts

Location: `src/ui/utils/uiHelpers.ts`

```typescript
import { createDivider, indentByLevel, isAgentDelegation } from '../utils/uiHelpers.js';

// Create divider respecting terminal width and limits
const divider = createDivider(terminalWidth);

// Create indentation (4 spaces per level)
const indent = indentByLevel(level);

// Check if tool is agent delegation
if (isAgentDelegation(toolName)) { }
```

### statusUtils.ts

Location: `src/ui/utils/statusUtils.ts`

```typescript
import { getStatusColor, getStatusIcon } from '../utils/statusUtils.js';

// Get color and icon for tool status
const color = getStatusColor(status);  // 'cyan', 'white', 'red'
const icon = getStatusIcon(status);    // ○ ◔ ◐ ● ✓ ✕ ⊘
```

### todoUtils.ts

Location: `src/ui/utils/todoUtils.ts`

```typescript
import { getCheckboxSymbol, getTodoColor } from '../utils/todoUtils.js';

// Get checkbox and color for todo status
const symbol = getCheckboxSymbol(status);  // ☐ ☑ ◯
const color = getTodoColor(status);        // 'yellow', 'green', 'gray', 'white'
```

### useContentWidth hook

Location: `src/ui/hooks/useContentWidth.ts`

```typescript
import { useContentWidth } from '../hooks/useContentWidth.js';

// Get terminal width capped at MAX_CONTENT_WIDTH (200)
const terminalWidth = useContentWidth();
```

## Components

### SelectionIndicator

Location: `src/ui/components/SelectionIndicator.tsx`

```typescript
import { SelectionIndicator } from './SelectionIndicator.js';

<SelectionIndicator isSelected={idx === selectedIndex}>
  {option.label}
</SelectionIndicator>
```

Displays green chevron and bold text when selected.

### KeyboardHintFooter

Location: `src/ui/components/KeyboardHintFooter.tsx`

```typescript
import { KeyboardHintFooter } from './KeyboardHintFooter.js';

<KeyboardHintFooter action="select" cancelText="cancel" />
```

Shows navigation hints: `↑↓ navigate  •  Enter select  •  Esc/Ctrl+C cancel`

### ModalContainer

Location: `src/ui/components/ModalContainer.tsx`

```typescript
import { ModalContainer } from './ModalContainer.js';

<ModalContainer borderColor="cyan">
  {children}
</ModalContainer>
```

Rounded border with consistent padding. Border colors: `cyan` (default), `yellow` (warning), `red` (error).

## Color Palette

Code Ally uses a **centralized color system** defined in `src/ui/constants/colors.ts`.

### Core Colors

| Color | Constant | Usage |
|-------|----------|-------|
| **Yellow** | `UI_COLORS.PRIMARY` | Mascot, cursor, user messages, selections, active states, in-progress todos, file/plugin mentions |
| **Orange** | `UI_COLORS.WARNING` (#ea800d) | Warnings, context usage 0-89%, attention states |
| **Red** | `UI_COLORS.ERROR` | Errors, cancellations, context 90-100%, destructive actions |
| **White** | `UI_COLORS.TEXT_DEFAULT` | Default text, completed items, success states, headers |
| **Gray** | `UI_COLORS.TEXT_DIM` | Borders, inactive items, metadata, timestamps, placeholders |
| **Black** | `UI_COLORS.TEXT_CONTRAST` | Text on yellow backgrounds (search highlights) |

### Using Colors

```typescript
import { UI_COLORS } from '@ui/constants/colors.js';

// Use constants instead of hardcoded strings
<Text color={UI_COLORS.PRIMARY}>Active</Text>
<Text color={UI_COLORS.TEXT_DIM}>Secondary</Text>
<ModalContainer borderColor={UI_COLORS.TEXT_DIM}>
```

Use `dimColor` prop for metadata and secondary information.

## Patterns

### Tool Status Display

```typescript
<Text color={getStatusColor(status)}>
  {getStatusIcon(status)} {toolName}
</Text>
```

### Todo Display

```typescript
<Text color={getTodoColor(status)}>
  {getCheckboxSymbol(status)} {content}
</Text>
```

### Complete Modal

```typescript
<ModalContainer borderColor="cyan">
  <Text bold>Title</Text>
  {options.map((opt, idx) => (
    <SelectionIndicator key={idx} isSelected={idx === selected}>
      {opt.label}
    </SelectionIndicator>
  ))}
  <KeyboardHintFooter action="select" />
</ModalContainer>
```

### Divider

```typescript
const divider = createDivider(terminalWidth);
<Text dimColor>{divider}</Text>
```

## Migration Notes

When updating components:

1. Replace hardcoded symbols with `UI_SYMBOLS`
2. Use `createDivider()` instead of manual calculations
3. Use `getStatusColor()` / `getStatusIcon()` for tool statuses
4. Use `getTodoColor()` / `getCheckboxSymbol()` for todos
5. Use `SelectionIndicator`, `KeyboardHintFooter`, `ModalContainer` for modals
6. Use `useContentWidth()` instead of raw `stdout.columns`

```typescript
// Constants
import { UI_SYMBOLS } from '@config/uiSymbols.js';
import { UI_COLORS } from '@ui/constants/colors.js';
import { TEXT_LIMITS, AGENT_DELEGATION_TOOLS } from '@config/constants.js';

// Utilities
import { createDivider, indentByLevel, isAgentDelegation } from '../utils/uiHelpers.js';
import { getCheckboxSymbol, getTodoColor } from '../utils/todoUtils.js';
import { getStatusColor, getStatusIcon } from '../utils/statusUtils.js';
import { getContextUsageColor } from '@ui/constants/colors.js';

// Components
import { SelectionIndicator } from './SelectionIndicator.js';
import { KeyboardHintFooter } from './KeyboardHintFooter.js';
import { ModalContainer } from './ModalContainer.js';

// Hooks
import { useContentWidth } from '../hooks/useContentWidth.js';
```
