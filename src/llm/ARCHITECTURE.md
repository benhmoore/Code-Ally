# LLM Integration Architecture

Visual guide to the LLM integration layer architecture and data flow.

---

## Component Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│                         Agent Layer                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │    Agent     │  │ToolManager   │  │  ToolOrchestrator    │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
└─────────┼──────────────────┼───────────────────────┼─────────────┘
          │                  │                       │
          │ uses             │ provides              │ executes
          ▼                  ▼                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                      LLM Integration Layer                       │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │              ModelClient (Abstract)                        │ │
│  │  • send(messages, options) → Promise<LLMResponse>         │ │
│  │  • get modelName(): string                                │ │
│  │  • get endpoint(): string                                 │ │
│  │  • cancel?(): void                                        │ │
│  └────────────────┬───────────────────────────────────────────┘ │
│                   │                                              │
│                   │ implements                                   │
│                   ▼                                              │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │              OllamaClient                                  │ │
│  │  • Connection management                                   │ │
│  │  • Streaming support                                       │ │
│  │  • Function calling                                        │ │
│  │  • Tool call validation                                    │ │
│  │  • Error handling + retry                                  │ │
│  │  • Cancellation via AbortController                        │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │              MessageHistory                                │ │
│  │  • Conversation state                                      │ │
│  │  • Token estimation                                        │ │
│  │  • Context management                                      │ │
│  │  • System message handling                                 │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │         FunctionCalling Utilities                          │ │
│  │  • Schema conversion                                       │ │
│  │  • Argument parsing                                        │ │
│  │  • Validation                                              │ │
│  │  • Tool result creation                                    │ │
│  └────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
          │                                  │
          │ HTTP requests                    │ events
          ▼                                  ▼
┌─────────────────────────┐    ┌──────────────────────────┐
│    Ollama API           │    │   ActivityStream         │
│  (localhost:11434)      │    │  (Event coordination)    │
└─────────────────────────┘    └──────────────────────────┘
```

---

## Data Flow: User Message → Tool Execution

```
┌──────────┐
│   User   │
└────┬─────┘
     │ "List files"
     ▼
┌────────────────────┐
│  Agent.process()   │
└────┬───────────────┘
     │
     │ 1. Add to history
     ▼
┌────────────────────┐
│ MessageHistory     │
│ [                  │
│   { role: 'system',│
│     content: '...' }│
│   { role: 'user',  │
│     content: 'List │
│     files' }       │
│ ]                  │
└────┬───────────────┘
     │ 2. Get messages + functions
     ▼
┌────────────────────────────────────────┐
│ client.send(messages, { functions })   │
└────┬───────────────────────────────────┘
     │
     │ 3. Prepare payload
     ▼
┌────────────────────────────────────────┐
│ OllamaClient._preparePayload()         │
│ {                                      │
│   model: 'qwen2.5-coder:32b',         │
│   messages: [...],                     │
│   tools: [                             │
│     {                                  │
│       type: 'function',                │
│       function: {                      │
│         name: 'bash',                  │
│         description: '...',            │
│         parameters: {...}              │
│       }                                │
│     }                                  │
│   ],                                   │
│   tool_choice: 'auto'                  │
│ }                                      │
└────┬───────────────────────────────────┘
     │
     │ 4. HTTP POST
     ▼
┌────────────────────────────────────────┐
│ fetch('http://localhost:11434/api/chat')│
└────┬───────────────────────────────────┘
     │
     │ 5. Response (streaming or complete)
     ▼
┌────────────────────────────────────────┐
│ Response Processing                    │
│                                        │
│ Non-streaming:                         │
│   • Parse JSON                         │
│   • Extract tool_calls                 │
│   • Validate & repair                  │
│                                        │
│ Streaming:                             │
│   • Read chunks                        │
│   • Aggregate content                  │
│   • Detect tool_calls                  │
│   • Check interruption                 │
└────┬───────────────────────────────────┘
     │
     │ 6. Return LLMResponse
     ▼
┌────────────────────────────────────────┐
│ {                                      │
│   role: 'assistant',                   │
│   content: '',                         │
│   tool_calls: [                        │
│     {                                  │
│       id: 'call-123',                  │
│       type: 'function',                │
│       function: {                      │
│         name: 'bash',                  │
│         arguments: {                   │
│           command: 'ls -la'            │
│         }                              │
│       }                                │
│     }                                  │
│   ]                                    │
│ }                                      │
└────┬───────────────────────────────────┘
     │
     │ 7. Execute tool
     ▼
┌────────────────────────────────────────┐
│ ToolOrchestrator.execute()             │
└────┬───────────────────────────────────┘
     │
     │ 8. Tool result
     ▼
┌────────────────────────────────────────┐
│ {                                      │
│   role: 'tool',                        │
│   tool_call_id: 'call-123',           │
│   name: 'bash',                        │
│   content: 'total 24\n...'            │
│ }                                      │
└────┬───────────────────────────────────┘
     │
     │ 9. Add to history
     ▼
┌────────────────────────────────────────┐
│ MessageHistory                         │
│ [                                      │
│   { role: 'system', ... },            │
│   { role: 'user', ... },              │
│   { role: 'assistant', tool_calls },  │
│   { role: 'tool', content }           │
│ ]                                      │
└────┬───────────────────────────────────┘
     │
     │ 10. Send again for synthesis
     ▼
┌────────────────────────────────────────┐
│ client.send(messages)                  │
└────┬───────────────────────────────────┘
     │
     │ 11. Final response
     ▼
┌────────────────────────────────────────┐
│ {                                      │
│   role: 'assistant',                   │
│   content: 'Here are the files in...' │
│ }                                      │
└────┬───────────────────────────────────┘
     │
     │ 12. Display to user
     ▼
┌──────────┐
│   User   │
└──────────┘
```

---

## Tool Call Validation Pipeline

```
┌─────────────────────┐
│  LLM Response with  │
│     tool_calls      │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────────────────────┐
│ normalizeToolCallsInMessage()       │
│                                     │
│ For each tool_call:                 │
│   1. Check structure                │
│   2. Attempt repair                 │
│   3. Collect errors                 │
└──────────┬──────────────────────────┘
           │
           ▼
     ┌────┴────┐
     │ Valid?  │
     └────┬────┘
          │
    ┌─────┴─────┐
    │           │
   Yes          No
    │           │
    ▼           ▼
┌────────┐  ┌──────────────────────────┐
│ Return │  │ Create error message:    │
│ success│  │                          │
└────────┘  │ "I encountered errors... │
            │                          │
            │ 1. Tool call 0: Missing  │
            │    function name         │
            │ 2. Tool call 1: Invalid  │
            │    JSON in arguments     │
            │                          │
            │ Please ensure format:    │
            │ { id, type, function }   │
            └──────────┬───────────────┘
                       │
                       │ Retry with feedback
                       ▼
            ┌──────────────────────────┐
            │ handleToolCallValidation │
            │ Retry()                  │
            │                          │
            │ messages = [             │
            │   ...original,           │
            │   assistantMsg,          │
            │   errorFeedback          │
            │ ]                        │
            │                          │
            │ send(messages)           │
            └──────────┬───────────────┘
                       │
                       │ Up to maxRetries
                       ▼
                 ┌─────────┐
                 │ Success │
                 │   or    │
                 │  Error  │
                 └─────────┘
```

---

## Repair Operations

```
Input: Malformed tool call
  ↓
┌─────────────────────────────────────┐
│ repairSingleToolCall(call, index)   │
└──────────────┬──────────────────────┘
               │
               ▼
    ┌──────────────────────┐
    │ 1. Fix Missing ID    │
    │    id = 'repaired-   │
    │          {time}-     │
    │          {index}'    │
    └──────────┬───────────┘
               │
               ▼
    ┌──────────────────────┐
    │ 2. Fix Missing Type  │
    │    type = 'function' │
    └──────────┬───────────┘
               │
               ▼
    ┌──────────────────────────────────┐
    │ 3. Convert Flat to Nested        │
    │    { name, arguments }           │
    │         ↓                        │
    │    { function: { name, args } }  │
    └──────────┬───────────────────────┘
               │
               ▼
    ┌──────────────────────────────────┐
    │ 4. Parse String Arguments        │
    │    '{"cmd":"ls"}'                │
    │         ↓                        │
    │    { cmd: 'ls' }                 │
    └──────────┬───────────────────────┘
               │
               ▼
    ┌──────────────────────────────────┐
    │ 5. Default Missing Arguments     │
    │    undefined                     │
    │         ↓                        │
    │    {}                            │
    └──────────┬───────────────────────┘
               │
               ▼
    ┌──────────────────────────────────┐
    │ Validate Final Structure         │
    │                                  │
    │ Required:                        │
    │   • id: string                   │
    │   • type: 'function'             │
    │   • function.name: string        │
    │   • function.arguments: object   │
    └──────────┬───────────────────────┘
               │
         ┌─────┴─────┐
         │           │
      Valid      Invalid
         │           │
         ▼           ▼
    ┌────────┐  ┌─────────┐
    │ Return │  │ Return  │
    │repaired│  │ errors  │
    └────────┘  └─────────┘
```

---

## Error Handling Flow

```
┌─────────────────────┐
│  Request Attempt    │
└──────────┬──────────┘
           │
           ▼
    ┌──────────────┐
    │ Execute HTTP │
    │   Request    │
    └──────┬───────┘
           │
           ▼
     ┌────┴────┐
     │Success? │
     └────┬────┘
          │
    ┌─────┴─────┐
    │           │
   Yes          No
    │           │
    ▼           ▼
┌────────┐  ┌──────────────────┐
│ Return │  │ Categorize Error │
│response│  └────────┬─────────┘
└────────┘           │
                     ▼
            ┌────────┴────────┐
            │                 │
         Network          JSON Parse
            │                 │
            ▼                 ▼
    ┌──────────────┐  ┌──────────────┐
    │ Exponential  │  │   Linear     │
    │  Backoff     │  │  Backoff     │
    │ wait = 2^n   │  │ wait = 1+n   │
    └──────┬───────┘  └──────┬───────┘
           │                 │
           ▼                 ▼
    ┌──────────────────────────┐
    │  Retry if attempts < max │
    └──────────┬───────────────┘
               │
         ┌─────┴─────┐
         │           │
     Retry       Exhausted
         │           │
         ▼           ▼
    ┌────────┐  ┌─────────────────────┐
    │ Loop   │  │ handleRequestError()│
    │ back   │  │                     │
    └────────┘  │ Return error with:  │
                │ • Description       │
                │ • Suggestions       │
                │ • Error flag        │
                └─────────────────────┘
```

---

## Cancellation Mechanism

```
┌──────────────────────┐
│  User presses Ctrl+C │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────────┐
│  client.cancel() called  │
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────────────┐
│ currentAbortController.abort()   │
└──────────┬───────────────────────┘
           │
           │ Signal propagates
           ▼
┌──────────────────────────────────┐
│ fetch() receives abort signal    │
└──────────┬───────────────────────┘
           │
           ▼
┌──────────────────────────────────┐
│ Streaming: reader.read() throws  │
│ Non-streaming: fetch() rejects   │
└──────────┬───────────────────────┘
           │
           ▼
┌──────────────────────────────────┐
│ catch (error)                    │
│   if (error.name === 'AbortError')│
└──────────┬───────────────────────┘
           │
           ▼
┌──────────────────────────────────┐
│ Return interrupted response:     │
│ {                                │
│   role: 'assistant',             │
│   content: '[Request cancelled]',│
│   interrupted: true              │
│ }                                │
└──────────────────────────────────┘
```

---

## Message History Management

```
┌─────────────────────────────────┐
│  Messages Array                 │
│  [                              │
│    { role: 'system', ... },    │  ← Always preserved
│    { role: 'user', ... },      │
│    { role: 'assistant', ... }, │
│    { role: 'tool', ... },      │
│    ...                          │
│  ]                              │
└──────────────┬──────────────────┘
               │
               │ enforceConstraints()
               ▼
┌──────────────────────────────────┐
│ 1. Separate system message       │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│ 2. Check message count           │
│    if (messages > maxMessages)   │
│      remove oldest (non-system)  │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│ 3. Estimate token count          │
│    totalChars / 4 ≈ tokens       │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│ 4. Check token limit             │
│    while (tokens > maxTokens)    │
│      remove oldest (non-system)  │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│ 5. Reconstruct array             │
│    [system, ...remaining]        │
└──────────────────────────────────┘
```

---

## Type Relationships

```
┌─────────────────────────┐
│      Message            │
│  role: MessageRole      │
│  content: string        │
│  tool_call_id?: string  │
│  tool_calls?: ToolCall[]│
│  name?: string          │
└──────────┬──────────────┘
           │
           │ array of
           ▼
┌─────────────────────────┐
│    LLMResponse          │
│  role: 'assistant'      │
│  content: string        │
│  tool_calls?: ToolCall[]│
│  thinking?: string      │
│  interrupted?: boolean  │
│  error?: boolean        │
└──────────┬──────────────┘
           │
           │ contains
           ▼
┌─────────────────────────┐
│      ToolCall           │
│  id: string             │
│  type: 'function'       │
│  function: {            │
│    name: string         │
│    arguments: object    │
│  }                      │
└──────────┬──────────────┘
           │
           │ validates against
           ▼
┌─────────────────────────┐
│  FunctionDefinition     │
│  type: 'function'       │
│  function: {            │
│    name: string         │
│    description: string  │
│    parameters: Schema   │
│  }                      │
└─────────────────────────┘
```

---

This architecture provides a clean, maintainable foundation for LLM integration with proper separation of concerns and comprehensive error handling.
