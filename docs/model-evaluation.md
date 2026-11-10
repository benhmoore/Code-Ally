# Model compatibility evaluation

The [model behavior report](model-behavior-results.md) records completed
comparisons, source identities, decisions, and limitations. Its evidence manifest
separates measured source epochs and the completed production checks; historical
runs do not stand in for validation of a later source revision.

`npm run eval:models` runs a versioned live-Ollama suite through Code Ally's
actual `OllamaClient`. It evaluates exact tool arguments, parallel tool calls,
recovery after a simulated tool failure, structured output, streaming, and the
configured reasoning control (including a native reasoning-trace assertion).

For a two-model comparison:

```bash
npm run eval:models -- \
  --models qwen3.8:27b-mlx,gemma4:31b-mlx \
  --runs 3 \
  --temperature 1 \
  --reasoning-effort low \
  --output model-eval-results/qwen3.8-vs-gemma4.json
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
same tool factory, visibility rules, and compact exposure policy used by interactive Ally.
Optional-tool schema probes explicitly activate their target capability. The `discovery` section instead performs a real two-request tool-search round trip, regenerates the exposed schemas, and scores the requested memory arguments without executing a memory write.

```bash
npm run eval:harness -- \
  --models qwen3.8:27b-mlx,gemma4:31b-mlx \
  --runs 3 \
  --temperature 0 \
  --sections prompt_tooling,behavior,schema_reliability,discovery,reasoning,late_reminder,structured_output \
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
`send-message` requires an available parent or peer; and `cleanup-call` requires removable
tool results. Ordinary coding turns omit volatile clock text. Execution policy
remains the authority—the gating only removes irrelevant provider schemas.

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

## Full coding smoke test

The direct-client harness `read_before_edit` scenario also executes the resulting `rangeSize` fixture after validating the submitted tool schema and applying the edit in memory. TypeScript is transpiled and checked on 100 numeric input pairs in a child process with V8 old-heap/time limits and a VM without host callbacks, IO, timers, or dynamic code generation; surviving VM global binding changes and intrinsic mutation fail. Equivalent formatting, pure Math calls, helpers, local variables and control flow are accepted. This is a generated-code benchmark execution boundary, not an OS security sandbox, a proof of purity, or an authorization grant for real tool actions. Suite version 17 restores the unified editing contract and retains the semantic scoring introduced in version 16.

The isolated coding evaluator runs the real `Agent`, provider client, permission layer, and built-in file/shell tools. The model reads a small JavaScript fixture, repairs an inclusive-range bug, and runs `node --test`. A separate process verifies the resulting source against additional trusted cases and checks that the visible test was not changed. The evaluator records tool results and the transcript, bounds execution time, and removes temporary workspaces.

```bash
npm run eval:coding -- \
  --model qwen3.8:27b-mlx \
  --endpoint http://localhost:11434 \
  --output model-eval-results/remote-coding.json
```

App state is isolated using `ALLY_DATA_DIR`, which overrides the default `~/.ally` data root. It is resolved once at process startup and can also be used for independent headless installations. Existing user configuration is not needed for this evaluator. The fixture is a smoke test, not a repository-scale coding benchmark.

## End-to-end behavior campaign

`npm run eval:behavior` runs disposable child processes around the real Agent, native streaming transport, canonical tool registry and exposure policy, session persistence, asynchronous delegation, and checkpoint continuation. It defaults to a 32k context and refuses smaller windows. Its seven cases cover multi-file option handling, stale-path recovery, deferred tool discovery, mid-task steering, delegated synthesis, restoration of original directions alongside externally changed facts after a durable checkpoint, and multiline editing with CRLF, Unicode, and similar neighboring functions.

```bash
npm run eval:behavior -- \
  --model qwen3.8:27b-mlx \
  --endpoint http://localhost:11434 \
  --runs 3 --variants baseline,outcome \
  --context-size 32768 --max-tokens 16384 --timeout-ms 600000 \
  --output model-eval-results/behavior-current-32k.json
```

Protocol 4 records explicit `editSurface` and `promptVariant` factors in each trial,
worker result, and resume identity. A single `baseline` uses the current production
factory and prompt. `baseline,outcome` holds that factory fixed and changes one
instruction about independent calls, bounded reads, and selecting the next missing
action. `baseline,exact-edit` compares the production unified-diff frontend against
the explicit exact-text candidate, with identical production system messages. Only
one editing frontend is registered in a normal request. The candidate failed the
selection gate and is not the production default. Protocols 1–3 remain historical
references and cannot resume into protocol 4. Counterbalanced trials apply matched backend seeds. Exact transmitted bodies, hashes, native responses, provider token usage, parent/child tool events, verification assertions, and terminal outcomes are retained. Independent checks execute copied source against trusted tests outside the working fixture, and protected public files must remain unchanged. The worker additionally records real fleet completion and checkpoint restoration from disk.

Fixture authorization permits repository file tools and the explicit test commands `node --test` and `npm test`. The task states these restrictions. This is a deliberate execution boundary, not an estimate of production Auto-mode refusal rates. File-tool paths are confined to the temporary workspace; that guard is not an operating-system sandbox for generated code. App state uses a sibling isolated `ALLY_DATA_DIR`, and workspaces are removed after each trial. No credentials, personal project instructions, or external services are needed.

Results checkpoint atomically after every trial. Resume with identical arguments plus `--resume`; changed code, Git revision, provider/model metadata, settings, or trial order are rejected. Failed, interrupted, and timed-out trials remain failures even if a partial artifact claims success. A nonzero process exit reports failed trials. Efficiency comparisons use successful matched pairs; pairs with infrastructure failures are excluded from resource means, and pairs with incomplete provider usage are also excluded from token means. Expected steering/delegation cancellation is distinguished from transport failure. Repeated calls are diagnostic counts, not proof that an operation was unnecessary.

Run only one inference campaign at a time. The runner refuses other resident models and never unloads them. It cannot detect another client's concurrent request to the same model; keep the server otherwise idle. Context configuration is not evidence of a filled-context workload. The checkpoint case explicitly exercises manual compaction and persistence; it is not a long-context endurance benchmark.

## Auto-mode behavior

`npm run eval:auto -- --endpoint http://localhost:11434 --reviewer tev1:4b --runs 3 --output model-eval-results/auto-behavior.json` evaluates the production permission service using real built-in schemas and capability/path metadata. It does not execute proposed actions. Ready, unavailable, and shadow modes cover authorized edits, contradictory or missing authority, injected instructions, size boundaries, literal read pipelines, delegation, questions, external paths, protected files, and test execution.

Artifacts include a mandatory preflight identity: reviewer digest and metadata, Ollama version, exact source manifest and policy/evaluator hashes, Git state, and Node version. A missing identity fails before model review. Earlier artifacts without this identity remain historical evidence with incomplete deployment provenance.

Auto artifact version 3 uses the production unified-patch schema. Calibration
protocol 3 requires a fresh version-3 capture and builds valid numeric contextual
patches checked by the host parser. Version-2 exact-schema calibration remains
historical evidence; it does not validate the restored production schema.

The artifact separates expected policy behavior from authorization friction. An authorized action can correctly require confirmation under the current execution envelope or reviewer capacity policy; that still represents friction to investigate. Full original human directions and exact proposed arguments are retained. No tool output or agent justification becomes human authorization. Reviewer recommendations never expand the host-enforced action envelope.

`node --import tsx src/evals/autoReviewAblation.ts --help` describes the reviewer-question comparison. It replays captured complete inputs and additional stress cases, changing the question independently of action eligibility. Do not lower a confidence cutoff merely to make positive examples pass; evaluate contradictory instructions and held-out negative cases too. These bounded measurements are not a security guarantee or calibrated error probability.

### Coverage and interpretation

Use independent behavior checks in addition to tool-schema validation. Keep requirements explicit in the task, including boundary values and files that must remain unchanged. The behavior fixtures derive their visible protected-file list from the same metadata used by verification, without revealing editable paths or discovery answers.

Preserve failed trials and original scores. If a verifier misses a requirement, publish a separate supplemental audit rather than rewriting the original artifact. Compare costs only for matched successful trials with complete provider usage; a deadline-related AbortError does not by itself establish a network fault. Repeated tool calls are diagnostic counts, not proof that the calls were unnecessary.

The cases provide bounded coverage. Checkpoint recovery creates a new SessionManager from disk but resumes the same Agent process. Protected-file hashes check terminal state; delegation telemetry does not exclude every inspection path or transient child write. Steering checks admission and final behavior without proving how the model reached its result. Context configuration is not a filled-context workload, and different native reasoning controls prevent simple cross-model latency rankings.

Measured outcomes and selection decisions are recorded in [model behavior results](model-behavior-results.md).

### Controlled execution and recovery

Use the configured production output ceiling when evaluating normal behavior
(currently 16,384 tokens). A 2,048-token run is a separate stress condition:
reasoning and tool arguments share that output budget, and repeated limit hits
can prevent a capable model from completing an edit. Preserve those failures as
stress results; do not mix their resource means with production-budget trials.
Keep context, output ceiling, temperature, and native reasoning settings identical
within each paired comparison. Native reasoning controls can differ across model
families, so these runs do not establish absolute cross-model latency rankings.

Before timing a model block, issue a separately recorded tiny warmup at the same
context size and confirm the response completed. Retain its exact request and
native response separately; warmup tokens and loading time are not task metrics.
Keep the client awake for the run using a temporary process-scoped wake lock when
needed. Do not change persistent power settings. End-to-end wall time can still
include compilation, caching, and service variability; prioritize correctness,
tool calls, and provider-reported token usage over small timing differences.

Workers use a private control channel for cancellation and acknowledge cleanup
only after their Agent, delegated tasks, Bash jobs, persistence, and transport
finish shutting down. The parent records timeout firing and overshoot, waits a
bounded cooperative grace, and falls back to terminating its owned worker.
A cleanup acknowledgment plus observed process exit and closed streams is required
for confirmed cleanup. If cleanup cannot be confirmed, the runner checkpoints the
failure, retains the workspace and owned-process diagnostics, and stops. It does
not continue a campaign beside an unknown surviving job. A failed or timed-out
trial cannot become a pass because its partial worker artifact says `passed`.

This control channel does not override operating-system signal restrictions.
The shared Bash termination primitive may remain pending if signals are denied;
the evaluation supervisor bounds that failure and reports unconfirmed cleanup.
Inspect and terminate only verified processes owned by the evaluation before
starting another run. Never infer permission to terminate a process from its port.
