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
same tool factory, visibility rules, and compact exposure policy used by interactive Ally.
Optional-tool schema probes explicitly activate their target capability. The `discovery` section instead performs a real two-request tool-search round trip, regenerates the exposed schemas, and scores the requested memory arguments without executing a memory write.

```bash
npm run eval:harness -- \
  --models qwen3.8:27b-mlx,muse-glimmer:30b-mlx \
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

The direct-client harness `read_before_edit` scenario also executes the resulting `rangeSize` fixture after validating the submitted tool schema and applying the edit in memory. TypeScript is transpiled and checked on 100 numeric input pairs in a child process with V8 old-heap/time limits and a VM without host callbacks, IO, timers, or dynamic code generation; surviving VM global binding changes and intrinsic mutation fail. Equivalent formatting, pure Math calls, helpers, local variables and control flow are accepted. This is a generated-code benchmark execution boundary, not an OS security sandbox, a proof of purity, or an authorization grant for real tool actions. Historical schema-declared patches retain their parser, and suite version 16 records this semantic scoring change.

The isolated coding evaluator runs the real `Agent`, provider client, permission layer, and built-in file/shell tools. The model reads a small JavaScript fixture, repairs an inclusive-range bug, and runs `node --test`. A separate process verifies the resulting source against additional trusted cases and checks that the visible test was not changed. The evaluator records tool results and the transcript, bounds execution time, and removes temporary workspaces.

```bash
npm run eval:coding -- \
  --model qwen3.8:27b-mlx \
  --endpoint http://100.68.102.73:11434 \
  --output model-eval-results/remote-coding.json
```

App state is isolated using `ALLY_DATA_DIR`, which overrides the default `~/.ally` data root. It is resolved once at process startup and can also be used for independent headless installations. Existing user configuration is not needed for this evaluator. The fixture is a smoke test, not a repository-scale coding benchmark.

## End-to-end behavior campaign

`npm run eval:behavior` runs disposable child processes around the real Agent, native streaming transport, canonical tool registry and exposure policy, session persistence, asynchronous delegation, and checkpoint continuation. It defaults to a 32k context and refuses smaller windows. Its seven cases cover multi-file option handling, stale-path recovery, deferred tool discovery, mid-task steering, delegated synthesis, restoration of original directions alongside externally changed facts after a durable checkpoint, and multiline editing with CRLF, Unicode, and similar neighboring functions.

```bash
npm run eval:behavior -- \
  --model qwen3.8:27b-mlx \
  --endpoint http://100.68.102.73:11434 \
  --runs 3 --variants baseline,outcome \
  --context-size 32768 --max-tokens 16384 --timeout-ms 600000 \
  --output model-eval-results/behavior-current-32k.json
```

Protocol 3 records explicit `editSurface` and `promptVariant` factors in each trial,
worker result, and resume identity. A single `baseline` uses the current production
factory and prompt. `baseline,outcome` holds that factory fixed and changes one
instruction about independent calls, bounded reads, and selecting the next missing
action. `baseline,exact-edit` compares the historical unified-diff frontend against
the exact-text frontend, with identical production system messages. The historical
frontend is an evaluator control; it is not registered in the normal tool library.
Only one comparison is allowed at a time. Protocol 1 and 2 artifacts remain historical
references and cannot resume into protocol 3. Counterbalanced trials apply matched backend seeds. Exact transmitted bodies, hashes, native responses, provider token usage, parent/child tool events, verification assertions, and terminal outcomes are retained. Independent checks execute copied source against trusted tests outside the working fixture, and protected public files must remain unchanged. The worker additionally records real fleet completion and checkpoint restoration from disk.

Fixture authorization permits repository file tools and the explicit test commands `node --test` and `npm test`. The task states these restrictions. This is a deliberate execution boundary, not an estimate of production Auto-mode refusal rates. File-tool paths are confined to the temporary workspace; that guard is not an operating-system sandbox for generated code. App state uses a sibling isolated `ALLY_DATA_DIR`, and workspaces are removed after each trial. No credentials, personal project instructions, or external services are needed.

Results checkpoint atomically after every trial. Resume with identical arguments plus `--resume`; changed code, Git revision, provider/model metadata, settings, or trial order are rejected. Failed, interrupted, and timed-out trials remain failures even if a partial artifact claims success. A nonzero process exit reports failed trials. Efficiency comparisons use successful matched pairs; pairs with infrastructure failures are excluded from resource means, and pairs with incomplete provider usage are also excluded from token means. Expected steering/delegation cancellation is distinguished from transport failure. Repeated calls are diagnostic counts, not proof that an operation was unnecessary.

Run only one inference campaign at a time. The runner refuses other resident models and never unloads them. It cannot detect another client's concurrent request to the same model; keep the server otherwise idle. Context configuration is not evidence of a filled-context workload. The checkpoint case explicitly exercises manual compaction and persistence; it is not a long-context endurance benchmark.

## Auto-mode behavior

`npm run eval:auto -- --endpoint http://100.68.102.73:11434 --reviewer tev1:4b --runs 3 --output model-eval-results/auto-behavior.json` evaluates the production permission service using real built-in schemas and capability/path metadata. It does not execute proposed actions. Ready, unavailable, and shadow modes cover authorized edits, contradictory or missing authority, injected instructions, size boundaries, literal read pipelines, delegation, questions, external paths, protected files, and test execution.

Artifacts include a mandatory preflight identity: reviewer digest and metadata, Ollama version, exact source manifest and policy/evaluator hashes, Git state, and Node version. A missing identity fails before model review. Earlier artifacts without this identity remain historical evidence with incomplete deployment provenance.

The artifact separates expected policy behavior from authorization friction. An authorized action can correctly require confirmation under the current execution envelope or reviewer capacity policy; that still represents friction to investigate. Full original human directions and exact proposed arguments are retained. No tool output or agent justification becomes human authorization. Reviewer recommendations never expand the host-enforced action envelope.

`node --import tsx src/evals/autoReviewAblation.ts --help` describes the reviewer-question comparison. It replays captured complete inputs and additional stress cases, changing the question independently of action eligibility. Do not lower a confidence cutoff merely to make positive examples pass; evaluate contradictory instructions and held-out negative cases too. These bounded measurements are not a security guarantee or calibrated error probability.

### Recorded behavior findings

The first completed 32k campaign recorded 36/36 passes under its original verifier
across six cases and three paired repetitions. A later audit found that its
configuration case omitted explicit null checks despite requiring only undefined
to trigger defaults. Those recorded passes therefore do not establish every
stated semantic requirement; the strengthened protocol retains this limitation
and the original artifacts. Replaying the six recorded configuration repairs
against explicit null cases confirmed baseline 3/3 and candidate 2/3; this
functional regression independently rejects the candidate. The longer outcome-oriented instruction did not provide a
consistent efficiency improvement, so production retains the existing prompt.
The first configuration baseline recovered from a transport failure: its matched
pair is excluded from resource comparisons. Delegation cancellation left some
usage incomplete; those pairs have no token-cost comparison. These exclusions
preserve functional outcomes rather than silently discarding failed requests.

The campaign exposed an output-budget defect: the Agent could replace the
configured output cap with a larger remaining-context allowance. The Agent and
compactor now honor the configured ceiling, further bounded by available context.
All 248 transmitted requests in the completed campaign used `num_predict=2048`.
Historical full-Agent coding results recorded configuration rather than this
wire-level invariant; their configured cap must not be read as a transmitted cap.

Auto's revised request budget retains complete original authority and proposed
arguments within one 64 KiB UTF-8 request. The allow-only cutoff of 0.95 improved
the measured reviewer operating point; deny remains 0.98. On 25 held-out cases
(10 authorized, 15 negative, each repeated three times), 0.95 approved 3/10
distinct authorized cases and none of 15 negative cases. A diagnostic 0.90 cutoff
incorrectly approved one qualified-approval case and was rejected. These are
finite synthetic samples for the measured reviewer, not calibrated safety scores.
The alternative reviewer question was also rejected.

On the 17 common baseline/refined Auto cases, clearly authorized ready-mode
approvals rose from 0/21 to 12/21 repeated decisions (four distinct cases gained).
The refinement changed both the budget and cutoff, so this does not isolate their
individual effects. The final readiness campaign still reports six failures:
two approximately 4,000-character argument cases abstained in all repetitions.
Arbitrary test runners and oversized authority also continue to ask under the
host policy. These remaining friction cases are retained as failures or explicit
policy limits; a green test suite does not mean every behavioral target passed.

Protocol 3 derives a visible protected-file list from the same fixture metadata
used by the verifier. It does not reveal editable paths or discovery answers.
It also checks explicit null and mixed undefined values in the configuration
case and requires the actual reported stale path to be the first main-agent read,
with a real file error. Historical artifacts retain their original scores;
supplemental audits are separate evidence rather than rewritten results.

Coverage remains bounded: delegation telemetry identifies ordinary parent reads
but does not prove absence of every alternative inspection path or transient
child write. Checkpoint recovery reconstructs a SessionManager from disk and
resumes the same Agent process; it does not simulate an entirely new CLI process.
Protected-file hashes check terminal state, not every transient mutation. Steering
checks admission and final behavior without establishing a causal explanation of
the model's plan. These limits constrain the conclusions from a passing trial.

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
