# Runtime architecture and design rationale

Code Ally separates conversation presentation, model context, and recoverable execution state.
These views have different retention and ownership requirements; none substitutes for another.
This document explains those boundaries and the constraints that changes must preserve.
The README covers setup and everyday commands.
Evaluation protocols and evidence belong in [model evaluation](model-evaluation.md)
and [model behavior results](model-behavior-results.md).

## Runtime ownership

The entry point composes services and selects Ink or the headless protocol.
Both frontends use `SessionRuntime` for admission, queued follow-ups, steering, and observation.
`Agent` owns an admitted turn; `TurnController` enforces its execution budgets.
`ConversationOperationQueue` serializes compaction and other conversation mutations at safe boundaries.
`ToolOrchestrator` owns validation, authorization, execution ordering, cancellation, and result delivery.
Provider clients own translation from internal messages to provider requests.

Admission and asynchronous preparation share cancellation and cleanup ownership.
Each turn releases its inference resources once during cleanup.
Idle model-generated messages are opt-in and yield to foreground work.
Shutdown stops producers before draining persistence and closing transports.
These rules apply to both interactive and headless execution.

`ActivityStream` publishes typed activity rather than owning conversation state.
`ConversationViewStore` supplies the UI projection; React owns presentation preferences and navigation.
Resume and rewind render the restored conversation state; the UI does not maintain a second copy.
Activity labels reflect the selected agent and distinguish inference, tool execution, waiting for agents, and user input.

## Model and tool interface

The normal minimum and default context target is 32,768 tokens.
A configured 131,072-token window is an upper-end working target, not a guarantee of effective recall.
Explicit smaller configurations support stress testing.
Small and medium models need bounded context and compact schemas at either target.
Model names do not establish provider capabilities, sampling behavior, or context capacity.

The ordinary coding core is `read`, `write`, `apply-patch`, `bash`, `grep`, `glob`, and `todo-write`.
`tool-search` exposes deferred capabilities such as memory, scheduling, and delegation when available.
Required tools and explicit discovery can expand the exposed surface within agent restrictions.
Discovery and request assembly share eligibility: a search result must be exposable on the next request.
If discovery is unavailable, permitted capabilities remain reachable through their schemas.
Native tool calling is the interface; a second text-based action protocol is unnecessary.

Schema validation precedes tool-specific semantic checks.
Tool definitions declare invocation capabilities and local paths.
Model arguments cannot override those declarations or grant access to another agent's tools.
Stable instructions precede volatile status and task context to avoid rewriting the entire prompt prefix.
Leaf agents receive direct-execution instructions rather than instructions to delegate again.

## Context, persistence, and recovery

`ConversationManager` separates the active model context from transcript history.
`ConversationCompactor` prepares a semantic checkpoint and commits it transactionally.
Failure before commit leaves the active conversation intact.
A checkpoint stores complete original user instructions and message IDs separately from the summary sent to the model.
Agent messages, hooks, and summaries cannot authorize actions on the user’s behalf.
The model’s current view can omit older instructions; `read-checkpoint` retrieves the complete archive.
Newer user instructions supersede conflicting older instructions.

Direction archive limits are explicit and checked before commit.
Older checkpoints remain readable, but previously discarded text cannot be reconstructed.
`SessionManager` stores manifests and immutable transcript segments independently of the live UI tail.
Pending persistence must retain admitted messages even after the visible tail evicts them.
Rewind changes the active branch without mixing pending appends from the previous branch.
Retention and deletion drain pending saves through the same serialized session owner.

`RunSupervisor` uses the run journal to track durable objectives and execution recovery.
If a tool’s outcome is unknown, recovery checks external state before retrying.
A model's completion statement remains a claim; independent evidence determines verified completion.

Provider projection defines which message data actually travels on the wire.
Native Ollama requests preserve native thinking and tool association fields while excluding UI metadata.
Stored conversations retain their presentation and recovery data.
Token estimates include plaintext reasoning when the selected provider replays it.
Display-only thoughts omitted by another provider do not acquire that replay cost.
Cache identity includes the replay policy so provider changes cannot reuse an incompatible estimate.

The same estimation basis feeds admission, compaction, output limits, and usage calibration.
Configured output ceilings remain ceilings even when the context window has more free space.
Reasoning-bearing samples do not train a negative fixed overhead that could hide replayed reasoning cost.
Counting transmitted native thinking is conservative: provider templates may omit some earlier thinking.
It is not an exact count of the provider's rendered prompt.

## Editing and authorization

Production `apply-patch` accepts contextual unified-diff hunks for one existing file.
`write` creates new files. An exact-text frontend remains an explicit evaluation candidate.
Normal requests expose one editing frontend, without model-specific selection or fallback.
Both frontends share immutable preparation, scoped read checks, preview, and final publication.

Shared text validation rejects invalid UTF-8, NUL text, and malformed Unicode in source and edits.
Transformed output is validated too; escaped payload repair cannot bypass that boundary.
Valid BOMs, literal replacement characters, and newline encodings retain their byte identity outside edits.
Preview and execution use the same source and argument snapshot.
The finalizer owns atomic compare-and-swap, cancellation at publication, read-cache updates, journaling, and undo.
Invocation cleanup releases prepared state after denial, interruption, failure, or success.

Manual, Auto, and Allow-all have one configuration and runtime owner.
Run-policy denials precede session trust and Auto decisions; switching modes does not approve an open request.
In Auto, application policy first determines which actions are eligible; a decision model then reviews eligible writes.
Ordinary workspace reads and code-owned bookkeeping need no model review.
Supported literal read commands execute with validated argv, paths, environment, and executable ownership.
Supported pipelines and conditionals use a fixed process executor rather than evaluating shell source.
In Auto, unknown commands, external effects, protected writes, and paths outside the workspace require approval.
Each delegated action retains its own authorization boundary.

Review receives the complete original user instructions and proposed arguments within a shared 64 KiB UTF-8 limit.
Missing authorization or a request exceeding that limit requires approval; instructions are never silently truncated.
The allow threshold is 0.95 and deny threshold is 0.98; other outcomes abstain.
These confidence cutoffs are not safety guarantees.
Readiness probes both authorized and contradictory actions through the production request builder.
Unavailable or invalid review visibly falls back to Manual; deterministic local admissions remain available.
Shadow recommendations do not grant permission.
Cancellation, generation checks, bounded responses, endpoint-scoped credentials, and cleanup reject stale reviews.
This application permission boundary is not an operating-system sandbox.

## Asynchronous work and terminal presentation

Delegation returns a background task receipt rather than blocking launch completion.
Active and idle agents use one queued messaging channel with explicit sender provenance.
Completion delivery belongs to the requesting conversation and its generation.
Completion notifications carry results without requiring acknowledgement turns.
Messages from agents remain distinct from user instructions after persistence and compaction.

Foreground commands, explicit background commands, timeout backgrounding, and manual detachment share one lifecycle.
Detachment preserves process identity, buffered output, cancellation ownership, and exactly-once completion delivery.
It does not reconstruct or fork the conversation.
Supervision-capacity failures report the error without abandoning a running foreground command.

Ink remains the renderer because replacing it also transfers input, Unicode, resize, scrollback, and teardown ownership.
The CLI enables incremental rendering; the conversation store coalesces streaming notifications.
Terminal measurements have one lifecycle per output, and bounded tool rendering measures the actual presentation.
Pi’s separate agent and terminal interfaces provide a useful design reference.
A replacement still needs measurements; using an alternate screen would also change scrollback and selection behavior.
A renderer migration needs representative replay traces and measured user-visible gains while preserving committed history,
input handling, accessibility, cancellation, and terminal restoration.

The [terminal UX audit](ux-fuzz-results.json) and [captures](ux-fuzz-evidence) retain representative interaction evidence.
They document the tested interaction states and terminal sizes, rather than every possible combination.
