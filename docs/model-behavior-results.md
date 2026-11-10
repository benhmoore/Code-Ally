# Model behavior evaluation results

The production prompt and unified-diff editor are retained. Alternative instructions and an exact-text editor caused task regressions and did not pass the selection criteria in [model evaluation](model-evaluation.md). Output-budget enforcement, provider message filtering, reasoning accounting, edit validation, and Auto review improvements are retained.

The November 2026 evaluations used the production Agent, tool registry, streaming client, delegation, and session persistence. Inference ran on a separate Ollama 0.40.15 server. The [evidence manifest](model-behavior-results.json) records revisions, settings, model digests, outcomes, and raw artifact hashes.

## Production checks

The runtime in content revision `a76079f` was evaluated at revision `a277b16`. Each trial had a 600-second deadline and a configured output ceiling of 16,384 tokens, further limited by available context.

| Model and setting | Cases passed |
|---|---:|
| Qwen3.8:27b-mlx, 32k context, temperature 0 | 7/7 |
| Gemma4:31b-mlx, 32k context, temperature 0 | 6/7 |
| Qwen3.8:27b-mlx, 32k context, temperature 1 | 2/2 |
| Qwen3.8:27b-mlx, fresh 128k checkpoint continuation, temperature 0 | 1/1 |

The seven cases cover configuration normalization, multiline editing, stale-path recovery, deferred tool discovery, mid-task steering, delegated synthesis, and checkpoint continuation after facts change on disk. The temperature-1 check covers the two editing cases.

Gemma's multiline trial passed its file and behavior assertions but exceeded the deadline. It remains a failed trial. Cancellation and cleanup were acknowledged without forced termination; the final request AbortError coincided with cancellation and does not establish a network fault.

All 17 trials confirmed cleanup. Inspection of 125 provider requests and 1,468 messages found no unsupported message fields, context/output-cap violations, or payload-hash mismatches. Warmup requests are excluded from task metrics.

These are single-run compatibility checks. Models, temperatures, and context settings are reported separately. Qwen used graded low reasoning; Gemma used its server's enabled thinking default. The results do not establish comparable reasoning work or an overall model ranking.

## Rejected alternatives

The outcome-oriented prompt experiment originally recorded 36/36 passes. Its verifier omitted explicit-null cases, despite requiring only undefined values to use defaults. Supplemental replay gives the production prompt **18/18** and the alternative **17/18**. The original artifact is unchanged; the supplemental results are recorded separately.

The controlled editor comparison used content revision `6113051`, two fixtures, three paired seeds, 32k context, temperature 0, and the same output ceiling. Its recorded pre-commit Git base is `38c9a8d`; reconstruction from `6113051` verifies the measured source.

| Model | Unified diffs | Exact text |
|---|---:|---:|
| Qwen3.8:27b-mlx | 6/6 | 6/6 |
| Gemma4:31b-mlx | 1/6 | 4/6 |

Qwen's jointly successful pairs used 17.03% fewer total provider tokens for configuration changes and 33.01% fewer for multiline changes with exact text. Inspection choices contributed: unified configuration trials included a denied Bash inspection and an additional read. These are end-to-end measurements, not isolated serialization savings or production Auto refusal rates.

Gemma had no jointly successful editing pair, so paired cost means are unavailable. One seed passed with unified diffs and timed out with exact text. Higher aggregate completion does not erase that regression.

Later results were mixed. At revision `7b3b25a`, one Qwen pair used fewer tokens with exact text for configuration changes but more for multiline changes. The paired temperature-1 check passed **2/2 with unified diffs versus 1/2 with exact text**: the exact-text trial changed required client return keys. A separate exact-text trial mishandled null. Both are task failures even though the tool applied the submitted text correctly. Exact text therefore remains an evaluation candidate, with no model-specific fallback or silent sampler change.

## Provider and context measurements

Filtering internal metadata from native Ollama messages reduced serialized HTTP request bytes by 27.34–37.93% in captured snapshots. This does not measure prompt-token or inference-latency savings.

Including replayed reasoning changed one local estimate from 5,690 to 16,495 tokens, against 16,404 server-reported prompt tokens. The estimate remains conservative because provider templates can omit older thinking.

The final 128k checkpoint check passed after a fresh model load, and the post-task context report was 131,072. An earlier reused MLX runner reported 32k despite receiving a 128k request. Ollama retains the initial soft context for reporting, so this alone does not establish a 32k execution limit. [MLX client](https://github.com/ollama/ollama/blob/v0.40.15/mlxrunner/client.go), [scheduler](https://github.com/ollama/ollama/blob/v0.40.15/server/sched.go).

A separate large-input diagnostic ended in a transport timeout during a host outage. It produced no usable token count or retrieval result; its cause is unestablished. **Full 128k retention remains unverified.** A configured window and a small checkpoint case are not a filled-context benchmark.

## Auto review

The production audit used canonical unified-patch inputs and `tev1:4b`. It contains 162 decisions: 18 distinct cases, three modes, and three repetitions. Proposed actions were not executed.

| Mode | Policy checks passed | Clearly authorized decisions allowed |
|---|---:|---:|
| Ready | 48/54 | 12/24 |
| Unavailable | 54/54 | 0/24 |
| Shadow | 54/54 | 0/24 |

Two approximately 4,000-character argument cases asked in every repetition, accounting for six failed policy expectations. Oversized authority and arbitrary test execution also asked, as required by the application policy. Three request errors were controlled outage probes; calibration had no request errors.

Calibration used 50 cases in two predeclared groups of 25, each repeated three times. At an allow cutoff of 0.95, the selection group approved eight of ten distinct positive cases; the held-out group approved three of ten. Neither group allowed any of its fifteen distinct negative cases. At 0.90, one held-out negative case was wrongly allowed in all repetitions, so that cutoff was rejected.

These synthetic classes were inspected in previous experiments; the split is not fresh blind validation. Negatives cover new-file writes, not malicious patch edits. Repetitions are not independent cases, and scores are not calibrated safety guarantees. Allow remains 0.95 and deny remains 0.98. Original instructions and arguments share a 64 KiB UTF-8 request limit.

Model identity is supported by Auto provenance, checks before each evaluation stage, and a matching provider snapshot after completion. The calibration artifact records the exact baseline and evaluator hashes; it does not embed a model digest on each response.

## Verification and limits

`npm run check` passes 301 test files and 3,881 tests, including TypeScript, lint, coverage gates, and build. Production runtime code and dependencies are unchanged from the evaluated revision. Subsequent evaluation-CLI changes only replace a machine-specific default endpoint with localhost; recorded remote runs supplied an explicit endpoint.

Checkpoint recovery reloads SessionManager from disk but reuses the Agent process. Protected-file hashes observe terminal state, not every transient change. Delegation checks do not exclude every alternative inspection path, and steering checks do not explain the model's internal plan. Fixture path guards are not an OS sandbox for generated code.

Raw evaluation files are retained locally under ignored `model-eval-results/`. They must accompany the manifest for an independent audit. The results support the tested configurations, not repository-scale reliability, universal correctness, or a general classifier safety rate.
