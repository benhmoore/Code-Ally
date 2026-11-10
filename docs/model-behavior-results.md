# Model behavior results

The existing production prompt and unified-diff editing contract are retained. The exact-text candidate failed the documented no-regression selection gate. Its host implementation applied submitted replacements correctly, but end-to-end task regressions still count. The restored default keeps the shared preparation, permission, atomic-write, and undo improvements. **Final live validation of the restored revision is pending the Studio returning online.**

## Implementation and selection

The edit backend owns scoped read evidence, immutable source and argument preparation, permission preview, byte-level comparison before publishing, cancellation, journaling, and undo. An observed existing empty file can be initialized and undone without deleting the file. Both evaluator frontends use this backend; normal model requests expose one editing tool. Exact matching remains an explicit evaluation candidate, with no model-name fallback or fuzzy replacement.

Agent and compactor output budgets now honor the configured ceiling and available context. Native Ollama messages transmit supported API fields while retaining native thinking and tool identity; harness metadata stays in persistence. Captured snapshots became 27.34–37.93% smaller in HTTP JSON bytes. This does **not** measure prompt-token or inference-latency savings.

Provider-owned reasoning replay participates in context estimation, cache identity, and budgeting. One recorded request improves from 5,690 to 16,495 estimated tokens versus 16,404 server-reported prompt tokens. Native templates can omit older thoughts, so the estimate remains conservative. Display-only reasoning from other providers does not acquire this cost. These fixes apply independently of the served model name.

The longer outcome-oriented prompt was rejected. Its original artifact recorded 36/36 passes, but supplemental replay of omitted explicit-null requirements yields baseline **18/18** versus candidate **17/18**. Original artifacts remain unchanged; the supplemental audit is separately hashed.

## Controlled editing comparison

The three-seed matrices used content commit `6113051`, source hash `8479a4739216ea761dff063571fd2812b6b9dc9df9af86b4b080017e7e2c9e27`, two fixtures, a 32,768 context setting, a configured 16,384 output ceiling, temperature 0, and a 600-second trial deadline. Raw metadata names the pre-commit Git base `38c9a8d`; an independent archive reconstruction verifies the measured content at `6113051`.

| Served model | Unified control | Exact candidate |
|---|---:|---:|
| Qwen3.8:27b-mlx | 6/6 | 6/6 |
| Gemma4:31b-mlx | 1/6 | 4/6 |

Qwen's jointly successful configuration pairs averaged 25,636.33 versus 21,269.67 total provider tokens, **17.03% fewer**, and eight versus six tool calls. Multiline pairs averaged 50,333.33 versus 33,719.67 tokens, **33.01% fewer**. Inspection choices contribute: every unified configuration trace began with a fixture-policy-denied Bash inspection and performed an additional read. These are end-to-end descriptive results, not pure serialization savings or production Auto refusal measurements.

Gemma had no jointly successful editing pair, so paired resource means are null. One multiline seed is a concrete regression: unified passed while exact reached its deadline. Three Gemma deadlines confirmed cooperative cleanup; their request AbortErrors do not establish an independent network fault. All 24 trial cleanups were confirmed. Higher aggregate completion does not erase the paired regression.

## Validation of candidate revision `7b3b25a`

A separate source epoch includes the later provider and reasoning-accounting fixes. All 784 source/config files matched the committed revision byte for byte. The seven production-tool cases cover configuration normalization, multiline editing, stale-path recovery, deferred discovery, steering, delegated synthesis, and durable checkpoint continuation.

| Explicit settings | Qwen | Gemma |
|---|---:|---:|
| Exact tool, 32k, temperature 0, seven cases | 7/7 | 4/7 |
| Separate exact-tool temperature-1 confirmation, two cases | 1/2 | — |

Gemma's failures were configuration null semantics, a multiline deadline, and malformed-input parser behavior. Its discovery assertions passed in that parser case. Historical editing controls remain separate from the seven-case rates.

The later single-pair Qwen cost results were mixed: exact configuration used 21,329 versus 25,800 tokens; exact multiline used 41,822 versus 32,973. The earlier average savings therefore do not establish a universal win on the corrected runtime.

The targeted paired temperature-1 follow-up passed **2/2 unified versus 1/2 exact**. The exact candidate changed the required client return keys from `attempts`/`active` to `retries`/`enabled`. The standalone temperature-1 failure instead mishandled null. Both are model-authored semantic errors, and both remain recorded. The paired regression rejects promotion under the selection gate. Global temperature remains unset by default; these runs do not justify a silent sampler change.

The original 21-trial validation batch confirmed cleanup throughout. Its wire audit covered 146 requests and 1,694 messages with no unsupported message fields or context/output-cap violations. Compaction requests stayed within 4,096 output tokens. Actual native reasoning controls differ across families; this is not an absolute model-quality or latency ranking.

## Auto review

The provenance-bearing `7b3b25a` audit contains 162 decisions: 18 distinct cases, three modes, and three repetitions. Proposed actions never execute. It used `tev1:4b` at the recorded digest and Ollama 0.40.15.

| Mode | Policy checks passed | Clearly authorized decisions allowed |
|---|---:|---:|
| Ready | 48/54 | 12/24 |
| Unavailable | 54/54 | 0/24 |
| Shadow | 54/54 | 0/24 |

Two approximately 4,000-character argument cases asked in every repetition, producing six policy failures. Oversized authority and arbitrary test execution also asked, as required by the host envelope. Three captured request errors were controlled outage probes; calibration had no request errors. Repetitions and modes are not independent cases.

Version-2 calibration used 50 cases split before inference into 25 selection and 25 held-out cases, repeated three times. At an allow cutoff of 0.95, selection approved 21/30 positive decisions (seven of ten distinct cases), and held-out approved 9/30 (three of ten). Neither split allowed any of its 45 negative decisions, representing fifteen distinct cases per split. The diagnostic 0.90 cutoff falsely allowed one held-out negative case in all three repetitions and was rejected.

The host retains the 64 KiB complete-request UTF-8 budget, 0.95 allow cutoff, 0.98 deny cutoff, and positive/contradictory readiness probes. Scores are not calibrated safety guarantees. Calibration negatives are write proposals, not negative exact-edit coverage. The restored unified production schema requires its own fresh audit/calibration epoch; old exact-schema results do not stand in for it.

## Context evidence and limits

The initial checkpoint run sent `num_ctx: 131072` and passed, while `/api/ps` reported 32768. Pinned Ollama code retains the initial MLX soft context for reporting and skips reloads for option changes; that report alone does not establish a 32k execution clamp. A fresh evaluation-owned load subsequently reported 131072 and completed its tiny warmup. [MLX client](https://github.com/ollama/ollama/blob/v0.40.15/mlxrunner/client.go), [scheduler](https://github.com/ollama/ollama/blob/v0.40.15/server/sched.go).

The larger synthetic provider probe ended in a TCP read timeout, followed by HTTP, SSH, and Tailscale reachability failures. It produced no usable provider token count or needle result. Its failure record discloses that the one-off helper did not persist the random request before fetch. The cause is unestablished; no model or Metal fault is inferred. Full 128k retention remains unverified.

The checkpoint case reconstructs SessionManager from disk and resumes the same Agent, rather than starting a new CLI process. Protected hashes check terminal state, not every transient mutation. Delegation telemetry does not exclude every alternative inspection path; steering checks do not prove a causal account of the model's plan. Fixture path guards are not an OS sandbox for generated code. Small successful pairs support descriptive costs, not statistical significance or repository-scale reliability claims.

Restored content commit `a76079f` passed `npm run check` in the main workspace: **301 files, 3,881 tests**, TypeScript, ESLint, coverage gates, and build. The source also matched the independently checked isolated tree byte for byte. Fresh live results for this revision remain pending. The [evidence manifest](model-behavior-results.json) retains source identities, hashes, failures, and incomplete work. Raw files are local ignored `model-eval-results/` artifacts and must accompany the manifest for an independent audit. See [evaluation protocols](model-evaluation.md) to reproduce the campaigns.
