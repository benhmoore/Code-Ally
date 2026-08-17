# Model compatibility evaluation

`npm run eval:models` runs a versioned live-Ollama suite through Code Ally's
actual `OllamaClient`. It evaluates exact tool arguments, parallel tool calls,
recovery after a simulated tool failure, structured output, streaming, and the
configured reasoning control (including a native reasoning-trace assertion).

For the Qwen3.8/Glimmer comparison:

```bash
npm run eval:models -- \
  --models qwen3.8:27b-mlx,muse-glimmer:30b-mlx \
  --runs 3 \
  --temperature 1 \
  --reasoning-effort low \
  --output model-eval-results/qwen3.8-vs-glimmer.json
```

The runner loads one model at a time, alternates their order between repetitions, and
writes the full raw responses plus timings, token usage, Ollama version, model
digest/details, suite version, settings, and Git revision. Result files are
ignored by Git by default; attach the chosen JSON artifact when publishing a
comparison.

Useful controls:

- `--runs N` changes the repetition count (default: 3).
- `--temperature N` applies an explicit temperature. Omit it to retain each
  model's backend-tuned default.
- `--reasoning-effort low|medium|high` selects graded reasoning (default: low).
- `--no-stream` tests non-streaming responses instead of Code Ally's normal
  streaming path.
- `--context-size`, `--max-tokens`, and `--timeout-ms` control resource limits.
- `--endpoint` selects a non-default Ollama server.

For a fair rerun, keep the suite version, Git revision, model digests, runner
settings, machine power state, and background workload fixed. Use at least three
repetitions; more runs reduce noise from sampling and local thermal conditions.

## Harness ablations

`npm run eval:harness` measures the parts of the harness that most directly
affect local-model behavior: system-prompt variants, lean/synthetic/production
tool sets, unnecessary calls and delegation, native parallel calls versus the
legacy batch wrapper, reasoning effort, late system reminders, and
schema-constrained output. The production-core profile is constructed from the
same tool factory and visibility rules used by interactive Ally.

```bash
npm run eval:harness -- \
  --models qwen3.8:27b-mlx,muse-glimmer:30b-mlx \
  --runs 3 \
  --temperature 0 \
  --sections prompt_tooling,behavior,reasoning,late_reminder,structured_output \
  --prompt-variants current_core,concise \
  --output model-eval-results/harness.json
```

`--prompt-variants` accepts `minimal`, `current_core`, `concise`,
`overlap_candidate`, `decision_candidate`, and `ship_candidate`. Omit it to run
all variants. Keep only the paired candidates for a final comparison so
unrelated controls do not consume inference time.

Temperature 0 is the deterministic primary pass. After choosing a candidate,
repeat the same cases at temperature 1 as a robustness pass; do not combine the
two temperatures into one aggregate.

### Capture the request Ally actually sent

After any model turn, run `/debug request` inside Ally. It writes a mode-0600
JSON file containing the exact provider-ready body captured at the send
boundary, including normalized messages, the dynamic reminder, model options,
and every built-in, plugin, and MCP tool visible on that turn. The snapshot also
contains its SHA-256 hash, character count, estimated tokens, message count, and
tool count.

Pass that file back to the evaluator to add a `captured_runtime` density and use
its tool surface for behavioral and reminder tests:

```bash
npm run eval:harness -- \
  --models qwen3.8:27b-mlx \
  --runs 3 \
  --temperature 0 \
  --request-snapshot /absolute/path/to/codeally-request-....json \
  --output model-eval-results/runtime-captured.json
```

The artifact includes the full normalized tool profiles, their hashes and token
estimates, a fixed-clock provider request fixture per model, server-reported
prompt/completion tokens, mean tool-call counts, and separate functional,
efficiency, and safety dimensions. Variant order is counterbalanced
deterministically across repetitions and models to reduce warm-order bias.

The evaluator checkpoints atomically after every case. Resume an interrupted
run with the same arguments plus `--resume`. It never terminates other Ollama
processes: it waits for an empty runner set and aborts if another model remains
loaded. Each artifact records exact prompts and hashes, raw responses, semantic
scores, timings, model digests, Ollama and Node versions, machine characteristics,
the evaluator-source hash, Git revision, and dirty-worktree state.

Keep the machine otherwise idle. Do not launch a second Ollama model workload
during a run; that invalidates latency comparisons and causes the isolation
check to stop the evaluator between model blocks.

Interactive requests also context-gate schemas that cannot help on the current
turn. Plan completion tools appear only in plan mode; scheduler, watcher,
line-number editing, agent management, and session-history tools require matching
user intent; background output/cancel/wait controls require matching task state;
`agent-ask` requires a persistent agent; and `cleanup-call` requires removable
tool results. Ordinary coding turns omit volatile clock text. Execution policy
remains the authority—the gating only removes irrelevant provider schemas.

### 2026-08-17 ship baseline

On `qwen3.8:27b-mlx` at temperature 0, three counterbalanced repetitions gave
the isolated concise prompt perfect scores in behavior (48/48 including
tool-error recovery), prompt/tool use (108/108 across three schema densities),
and schema reliability (99/99). The longer ship candidate tied every correctness
and call-count score, but added roughly 62–93 input tokens per request and
6–12 output tokens in the paired aggregates. The concise variant therefore won
under the selection protocol below. With the full stable production context and
final 20-tool surface, the ship gates retained 100% functional and safety
behavior, 108/108 schema reliability, and 108/108 prompt/tool use. The deliberately
ambiguous deletion case still paired one batched glob with one directory listing,
reducing only the behavior-efficiency dimension (45/48 overall).
At temperature 1, the same final surface retained 27/27 functional behavior,
3/3 safety, and 108/108 schema reliability; additional redundant discovery
reduced only behavior efficiency (44/48 overall).

The default first-turn built-in surface is 20 tools after contextual gating,
down from the former 33-tool surface. The final stable prompt is 153 estimated
tokens including the deterministic evaluation context, and its default schemas
are 2,957 tokens. Together they are about 53% smaller than the former baseline;
actual Ollama prompt usage on matched runtime-core cases fell about 49%.
`glob` also accepts a `patterns` array, collapsing alternative filename searches
into one provider call while retaining singular `pattern` as an execution-only
legacy alias. Re-run these measurements when tool descriptions, provider
serializers, or the model digest changes.

### Selection protocol

Change one independent variable per comparison and keep the request snapshot,
model digest, suite version, context size, max output, machine power state, and
background workload fixed. Use this decision order:

1. Reject any candidate with a functional or safety regression.
2. Among statistically tied candidates, prefer fewer tool calls, then fewer
   prompt/completion tokens, then lower elapsed time.
3. Require the win to reproduce across at least three paired repetitions.
4. Confirm the winner at temperature 1 and on the captured runtime tool surface.

Do not treat a shorter prompt as a win by itself. It is only more efficient if
behavior remains at least as accurate and safe.
