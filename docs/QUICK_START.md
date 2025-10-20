# Code Ally - Quick Start

## Running the Application

```bash
npm run dev
```

The application will start and display:
- Header with Code Ally branding
- Message history (last 5 messages)
- Active tool calls (if any)
- Input prompt
- Footer with status information

## Using the App

### Type Messages

Simply type your message and press Enter:

```
> Hello there
```

The app will echo back your message (placeholder behavior until Phase 6).

### Exit the Application

Type one of these commands:
- `exit`
- `quit`

Or press `Ctrl+C` to force quit.

### Multiline Input

Press `Ctrl+Enter` to add a newline without submitting.

### Clear Input

Press `Ctrl+C` once to clear your current input buffer.

## Current Status

**Phase 4 Complete** - The UI is functional but agent integration is not yet complete.

### What Works
- Interactive terminal UI
- Message display
- Input handling
- Exit commands
- Event system ready

### What's Coming
- **Phase 5**: Remaining tools (Write, Edit, Grep, Glob, Ls)
- **Phase 6**: Agent orchestration (connect to LLM)
- **Phase 7**: Full integration
- **Phase 8**: Polish and advanced features

## Testing

The app currently operates in "echo mode" - it will repeat back what you type. This demonstrates:
1. Input capture working
2. Message state management working
3. Display rendering working
4. Event system ready for integration

Once Phase 6 (Agent Orchestration) is complete, messages will be:
1. Sent to the LLM (Ollama)
2. Processed for tool calls
3. Tools executed with visual feedback
4. Responses streamed back to the UI

## Architecture

```
You type → InputPrompt → handleInput()
                             ↓
                   actions.addMessage()
                             ↓
                   AppContext state update
                             ↓
                   React re-renders
                             ↓
                   MessageDisplay shows your message
```

## Development Mode

The app runs with `tsx` for hot TypeScript execution. Changes to source files require a rebuild:

```bash
npm run build
npm run dev
```

Or use nodemon for auto-restart:

```bash
npx nodemon --exec npm run dev
```

## Configuration

Config file: `~/.ally/config.json`

The app will warn about unknown config keys from the Python version. These warnings are harmless and will be removed in Phase 6.

## Troubleshooting

### App exits immediately
- Fixed in latest version
- Make sure you pulled latest changes
- Rebuild: `npm run build`

### Input not working
- Make sure terminal supports Unicode
- Check that Ink is properly installed: `npm install`
- Try a different terminal emulator

### Build errors
- Run: `npm run type-check`
- Fix any TypeScript errors shown
- Rebuild: `npm run build`

## Next Steps

Try the app and explore the UI. Once you're comfortable:

1. Review `docs/INK_ARCHITECTURE_DESIGN.md` for architecture details
2. Check `docs/PHASE_4_COMPLETE.md` for implementation status
3. Wait for Phase 6 to connect the agent orchestrator

The foundation is solid and ready for the next phase of development.
