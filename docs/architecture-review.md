# Code Ally architecture review for local models

Code Ally targets small and medium local models through a compact tool interface, explicit execution contracts, bounded model context, and durable task evidence. This review and refactor preserves the existing separation between the visible transcript, active model context, and recoverable run state. It changes the boundaries where those contracts were inconsistent or expensive.

The initial target exercised locally is `qwen3.8:27b-mlx`, served by Ollama with the MLX runner and NVFP4 weights. A model name is not a capability guarantee: provider discovery and actual wire tests remain authoritative. The implementation does not impose guessed Qwen sampling settings; backend defaults remain available.

## Architecture and ownership

The entry point composes services and selects either Ink or the headless protocol. Both frontends use `SessionRuntime` for admission, queued follow-ups, steering, and observation. `Agent` owns one admitted turn, with `TurnController` enforcing execution budgets and `ConversationOperationQueue` serializing compaction and other mutations at safe boundaries. `ToolOrchestrator` owns authorization, execution ordering, cancellation, and result delivery. Provider clients translate the model request at the boundary.

`ConversationManager` separates active context from transcript history. `ConversationCompactor` prepares a semantic checkpoint and commits it transactionally. `SessionManager` persists manifests and immutable transcript segments; `RunSupervisor` separately owns journal-authoritative durable objectives. A model completion statement is a claim, not independent verification.

`ActivityStream` publishes typed activity. `ConversationViewStore` and `SessionRuntime` expose snapshots to the UI. Terminal dimensions now have one measurement store per Ink output, rather than independent resize subscriptions in each layout hook.

| Boundary | Finding | Implemented behavior |
| --- | --- | --- |
| Turn admission | Cancellation while a submit hook awaited could be reset before execution | Cancellation is initialized before admission and checked after preparation |
| Turn cleanup | Turn-start persistence could fail after pausing a parent but before entering cleanup | Preparation and inference share the same cleanup boundary |
| Local inference ownership | Post-response and final cleanup both decremented idle ownership; finalization could resume generation | One acquired coordinator reference is released once at actual turn cleanup |
| Idle inference | Cosmetic messages consumed local inference by default | Model-generated idle messages are opt-in; admitted work cancels idle generation |
| Tool exposure | Large context windows exposed optional schemas even when unnecessary | Stable coding core plus discovery, with explicit requests and requirements pinned |
| Tool registry | Empty allow-list shared a cache key with unrestricted access; sorting mutated callers | Structured cache keys preserve empty policy and caller ownership |
| Tool validation | Semantic validation could receive malformed provider arguments | JSON/schema validation precedes tool-specific checks; unknown fields respect schema policy |
| Tool discovery | Agent-specific visibility was omitted in searches | Discovery uses the calling agent's visibility scope |
| Provider request | OpenAI-compatible requests dropped structured output schemas | Real requests, previews, and fallback requests preserve response schemas |
| Provider stream | Final SSE data without newline was lost; DONE did not stop reads | Final buffered data is processed and DONE terminates consumption |
| Prompts | Leaf agents were told to delegate despite having no delegation capability | Leaf instructions consistently use direct tools across thoroughness levels |
| Compaction | Intermediate user directions could be truncated or dropped in extractive fallback | Full original directions are retained separately from the fitted model view |
| Session retention | Expiry bypassed deletion ownership and leaked transcript directories/cache | Retention drains pending saves and reuses serialized deletion |
| Submission | Images attached during an active turn were discarded by text steering | Image submissions queue with an owned copy of attachments |
| Terminal UI | Layout hooks accumulated resize listeners; plan wrapping ran on unrelated input | Shared stream measurements and memoized plan wrapping |
| Capability cache | Unawaited writes could reject outside command error handling | Cache failures are handled without invalidating successful probes; timers settle |

## Small model interface

The normal minimum target and default is 32k (32,768 tokens). 128k (131,072 tokens) is the upper-end working target. Explicit 16k configurations remain useful for compaction stress tests; setup and configuration suggestions start at 32k. Tool schemas remain compact at every context size.

The ordinary coding surface is `read`, `write`, `apply-patch`, `bash`, `grep`, `glob`, and `todo-write`, plus `tool-search` when capabilities are deferred. Durable objectives retain their completion/blocking protocol. `ls`, `tree`, memory, scheduling, delegation, and other optional capabilities remain discoverable. Required tools and explicit searches override the nominal schema share, while authorization and agent restrictions still apply. If discovery is unavailable, permitted schemas remain exposed rather than becoming unreachable.

Measured over the complete built-in registry using the repository tokenizer:

| Surface | Definitions | Estimated tokens |
| --- | ---: | ---: |
| Full registered schemas | 39 | 7,005 |
| Compact exposed schemas | 10 | 1,987 |
| Deferred catalogue | 29 entries | 578 |
| Compact schemas plus catalogue | | 2,565 |

This reduces that input payload by 63%. Runtime policy can filter the registry further. Token counts use the repository estimator, not a claim of exact Qwen tokenization. Discovery adds a round trip when an optional capability is first needed; the live evaluator now tests that tradeoff explicitly.

The stable system prefix and trailing volatile context are retained. Changing the date, todos, or status should not rewrite the entire prefix on each round trip. Native provider tool calling remains the contract; the harness does not add a second ReAct text protocol. [Qwen's function-calling guidance](https://github.com/QwenLM/Qwen3/blob/main/docs/source/framework/function_call.md) cautions that stopword-based tool templates can collide with reasoning output. Structured responses use provider schemas where supported, consistent with [Ollama's structured-output API](https://github.com/ollama/ollama/blob/main/docs/capabilities/structured-outputs.mdx).

## Context accuracy and persistence

Compaction retains a harness-owned `userDirections` archive containing full submitted user text and source message IDs. Hook additions and harness messages are excluded. Model-generated summaries cannot replace this archive. The fitted checkpoint may omit entire older directions to meet the input budget; `read-checkpoint` retrieves the complete archive with pagination. The checkpoint tells the model to retrieve user directions and constraints before final verification, and newer directions supersede conflicting older ones.

The durable archive has explicit limits of 4,096 directions or 1,000,000 characters. Exceeding them fails compaction before commit and leaves the active conversation unchanged. Old version-1 checkpoints remain readable; their original objective/current request are recoverable, but historical text already discarded by an older checkpoint cannot be reconstructed. Tests cover repeated committed extractive compactions, exact long intermediate directions, persistence/reload, pagination, and rollback at the limit.

Session manifests and immutable transcript segments remain separate from model context. Retention now waits for pending autosaves, deletes through the per-session queue, invalidates the cache, and removes the session's segment directory. Existing run journals, exclusive ownership, unknown tool-effect reconciliation, and checkpoint commit semantics are preserved.

## Comparison with the local Pi source

The local `/Users/benmoore/pi` source was the comparison target, including `packages/agent/src/agent-loop.ts`, coding-agent tools, system prompting, session persistence, and terminal infrastructure.

Pi's reusable agent loop makes message conversion and next-turn preparation explicit at the model boundary, and handles steering again after asynchronous preparation. Code Ally already has a frontend-neutral session runtime and safe-boundary operations; the refactor repairs admission and cleanup gaps within that ownership model. Replacing the entire loop would also require preserving durable objectives, tool-effect journals, scoped delegation, and existing headless behavior.

Pi's small primary tool vocabulary and conditional guidance support a compact default surface. Ally now uses that principle while retaining discovery for its broader tool library. Native parallel calls remain available; a redundant batch wrapper is not added to the production surface.

Pi uses append-oriented session storage. Ally's immutable transcript segments already avoid rewriting full transcript history; the actual storage defect was retention bypassing deletion ownership. Pi's explicit terminal boundary also informed using Ink's configured output and a single measurement lifecycle.

## Validation and interpretation

`npm run check` checks TypeScript, lint, the coverage-gated test suite, and the production build. Regression tests exercise failure and concurrency paths, not just snapshots of the new implementation. Live model probes are separate from unit tests, so ordinary validation does not require a model or mutate user capability caches.

The initial compaction-stress smoke comparison uses 16,384 context tokens, 2,048 output tokens, temperature 0, and one repetition of selected cases. It is a smoke comparison, not an estimate of general coding accuracy or a statistically controlled latency benchmark. Local runner cache, thermal state, and concurrent development can affect timing. The versioned JSON results retain raw responses, scores, settings, model metadata, and request profiles.

A broad quality claim needs repeated repository tasks, long-context steering, tool failures, interruptions, and end-to-end edits across multiple local models. The changes here establish explicit contracts and runnable evaluations for those measurements; passing these probes alone does not establish parity with frontier coding agents.

## Local Qwen smoke results

All 20 selected baseline probes and all 21 compact-profile probes achieved full scores, including the added discovery round trip (7/7). The two runs used the same local model and settings; the evaluator version changed to add discovery and apply production exposure policy.

| Probe group | Before mean prompt tokens | Compact mean prompt tokens | Before mean elapsed | Compact mean elapsed |
| --- | ---: | ---: | ---: | ---: |
| Runtime tool selection, 3 cases | 6,824 | 3,466 | 10.95 s | 7.35 s |
| Argument schemas, 7 cases | 5,171 | 2,686 | 4.87 s | 4.15 s |

Runtime selection probes compare native schemas without the deferred catalogue. The separate discovery probe includes the catalogue and completes two model requests in 9.70 seconds, with 5,970 total prompt tokens. These timings are observations from one repetition, not expected production speedups.

The [recorded summary](local-model-results.json) contains settings and all group scores. Full raw local artifacts are `model-eval-results/qwen-review-baseline.json` and `model-eval-results/qwen-review-compact.json`; evaluation artifacts are intentionally ignored by Git.

Further Qwen inference uses `http://100.68.102.73:11434` at the user's request. This server responds as Ollama 0.40.15 and advertises the same `qwen3.8:27b-mlx` model digest. Remote results are kept separate from laptop timing comparisons.

## Terminal renderer decision

Retain the pinned Ink renderer for this refactor. Neither Pi's implementation nor an in-house replacement demonstrates a performance advantage for Code Ally's actual workload from source inspection alone. A new renderer would also own Unicode cell widths, wrap/resize recovery, cursor tracking, Kitty input, bracketed paste, mouse routing, terminal restoration, accessibility, and terminal-specific behavior.

Code Ally already enables Ink's changed-line writer in `src/cli.ts`. The installed Ink 7.1.1 implementation skips unchanged rows, supports cursor-only updates, synchronizes terminal writes, and handles static-output/overflow recovery. `ConversationViewStore` coalesces streamed notifications at 50 ms; Ink defaults to a 30 fps render throttle. A local scheduling check delivered 200 five-character chunks at roughly 1 ms intervals, retained all 1,000 characters, and produced five store notifications over 299 ms including its final wait. This measures notification batching, not render latency or a speed comparison with Pi.

Pi's `Component` contract is imperative `render(width): string[]`, invalidation, and focused input handling. Its container still walks children and its renderers compare output rows; text and Markdown cache by width/content. The local main-screen renderer calls a full screen and scrollback clear on width changes, most height changes, and changes above the viewport (`packages/tui/src/tui-main-screen.ts`). Adopting that policy directly would conflict with Ally's committed-scrollback regression tests. Pi's alternate-screen renderer provides application-owned scrolling, search, selection, and images, but that is a product-mode change rather than a transparent performance replacement.

The migration surface includes at least 61 UI files importing Ink, the editor and completion flow, modal input precedence, mouse hitboxes, static-history policy, and terminal tests. Pi's five core terminal/render/input files alone contain about 5,128 lines, excluding editor, layout, and Unicode helpers. An in-house implementation does not remove this responsibility.

A migration should be evaluated with identical replay traces at 80x24 and 40x12: long committed history, settled tools, streamed text and tool output, input while streaming, resize, menus, rewind, foreground switching, cancellation, multiline paste, CJK/emoji, tmux, and teardown. Measure output bytes/writes, frame frequency, end-to-end chunk/key-to-paint latency, CPU, and peak memory. Ink's `onRender` callback covers only part of the rendering pipeline and cannot substitute for end-to-end latency. Require no lost input, erased/duplicated committed history, or accessibility regression. A custom writer or alternate renderer becomes justified when a repeatable user-visible bottleneck cannot be fixed within the existing renderer boundary.

Claude Code's public documentation describes a virtualized alternate-screen mode that renders visible messages, with application-owned scrolling and selection. It also retains a classic mode for native scrollback and screen readers. That supports treating fullscreen as a deliberate UX/virtualization decision, rather than evidence that replacing React or Ink alone improves performance. Its undocumented internal implementation is not used as a design premise here. [Claude Code fullscreen documentation](https://code.claude.com/docs/en/fullscreen).

## Remote target validation

At 32k, three repetitions completed all 51 selected tool-selection, argument-schema, and discovery probes with full scores. The real coding loop then passed at both 32k and 128k: it read the fixture, repaired the source, ran the authorized test command, preserved the visible tests, and passed independent verification. The 32k run completed in 27.66 seconds and the 128k run in 26.47 seconds. These are short tasks configured with those windows, not tests that fill 128k tokens or establish equal long-context accuracy. One disallowed exploratory shell command was rejected and the agent recovered through filesystem tools; authorization remained enforced.

Raw remote artifacts are `model-eval-results/qwen-remote-32k.json`, `qwen-coding-32k.json`, and `qwen-coding-128k.json`. Their scores and settings are also included in [the recorded summary](local-model-results.json).

The UI consolidation removes the parallel conversation reducers from `AppContext` (711 to 139 lines). The conversation owner now supplies messages, tool state, thinking, status, context usage, and compaction notices. React retains presentation preferences and navigation only. Tool-expansion actions update the authoritative store and survive frontend remounts; resume/rewind repaint the restored owner projection rather than reconstructing another copy. Duplicate batching timers and activity subscriptions were removed. This is a completed ownership change, not an adapter for a second rendering implementation.

Live-message bounding now walks backward only until the count/byte limit is reached instead of cloning discarded old history first. Settled tool rows preserve object identity once their output is bounded, so unrelated streaming updates do not invalidate those memoized rows. Regression tests enforce both the bounded traversal cost and settled-row identity.

Final validation after UI consolidation: `npm run check` passed TypeScript, zero-warning ESLint, 236 test suites (3,135 passed, 3 skipped), all coverage gates, and the production build. `git diff --check` also passed. No dependency installation or package migration was required.
