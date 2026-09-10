# Headless Protocol

Run Code Ally unattended and read its output as JSON.

## Flags

| Flag | Values | Default | Meaning |
|---|---|---|---|
| `--once <message>` | text | - | Run one turn and exit. Optional with stream-json input. |
| `--output-format` | `text`, `json`, `stream-json` | `text` | What stdout carries. |
| `--input-format` | `text`, `stream-json` | `text` | Where turns come from. |
| `--session-id <id>` | safe file name | - | Create this run's session under a caller-chosen id. |
| `--json-schema <schema>` | inline JSON or `@path` | - | Schema the final answer must satisfy. Needs a json output format. |

`--session-id` is `--session <name>` with a caller-chosen name: same code path,
plus a check that the id is a single safe file name of letters, digits, dot,
dash and underscore. It is the id reported as `session_id` on every event.

`text` keeps the existing behavior: the final response on stdout, then
`[Session: <name>]` when the run used a session.

## Wire events

In `json` and `stream-json` modes stdout carries nothing but wire events, one
JSON object per line. Diagnostics go to stderr and the logger. `json` writes
the terminal `result` object only; `stream-json` writes every event below.

```jsonc
{"type":"system","subtype":"init","session_id":"run-1","model":"qwen3","tools":["bash"],"cwd":"/work"}
{"type":"assistant","session_id":"run-1","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}
{"type":"tool_use","session_id":"run-1","id":"call-1","name":"bash","input":{"command":"ls"}}
{"type":"tool_result","session_id":"run-1","tool_use_id":"call-1","is_error":false,"content":"src"}
{"type":"control_response","session_id":"run-1","response":{"subtype":"success","request_id":"req-1"}}
{"type":"result","subtype":"success","session_id":"run-1","result":"...","outcome":{"kind":"completed","summary":"..."},"duration_ms":1200,"num_turns":1,"is_error":false}
```

Every turn ends with exactly one `result`.

- `subtype` is `success` for a completed outcome, `error_during_execution` for
  a turn stopped by an interrupt, and `error` otherwise.
- `outcome` is the run supervisor's typed outcome, untouched.
- `structured_output` is present once a structured-output schema is in use.
- `is_error` is true whenever `subtype` is not `success`.

## Structured output

`--json-schema <schema>` takes an object schema, inline or as `@path`. It
requires `--output-format json` or `stream-json`; a schema that is malformed,
unreadable, or not an object schema is a startup error.

The schema becomes the parameters of a `structured-output` tool registered for
that run only. The root agent must call it before its turn can end, so the
final answer is a validated tool call rather than prose to parse. The payload
appears as `structured_output` on the `result` event.

Validation is exact: `enum`, nested objects with `required`, array `items`,
`integer` against `number`, and `additionalProperties: false`. A rejected call
returns a `validation_error` naming the JSON path, and the model retries.

```bash
ally --once "triage the open findings" --output-format json --json-schema @verdict.json
```

## Stdin protocol

With `--input-format stream-json` the process reads line-delimited JSON from
stdin. `--once` is then optional; when given it is the first turn.

Send a user message:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"list the files"}]}}
```

A plain string `content` is also accepted. A message that arrives while a turn
is running is delivered as an interjection into that turn; one that arrives
while the session is idle starts a new turn.

Interrupt the running turn:

```json
{"type":"control_request","request_id":"req-1","request":{"subtype":"interrupt"}}
```

The session answers with a `control_response` carrying the same `request_id`.
The interrupted turn still emits its own `result`, with subtype
`error_during_execution`.

A line that is not valid JSON, or not one of these two shapes, is reported on
stderr and the session keeps reading. The process exits when stdin closes and
the current turn has ended.

## Exit codes

From the run outcome, the same mapping every automatic run uses.

| Outcome | Code |
|---|---|
| `completed` | 0 |
| `failed` | 1 |
| `blocked` | 2 |
| `retryable_failure` | 75 |
| `cancelled` | 130 |

With stream-json input the exit code comes from the last turn.

## Example

```bash
ally --once "summarize src/cli.ts" --output-format stream-json --session-id review-1
```

```bash
printf '%s\n' '{"type":"user","message":{"role":"user","content":"hello"}}' | ally --input-format stream-json --output-format stream-json
```
