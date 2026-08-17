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
affect local-model behavior: system-prompt variants, lean versus representative
tool sets, native parallel calls versus the legacy batch wrapper, reasoning
effort, late system reminders, and schema-constrained output.

```bash
npm run eval:harness -- \
  --models qwen3.8:27b-mlx,muse-glimmer:30b-mlx \
  --runs 3 \
  --sections prompt_tooling,reasoning,late_reminder,structured_output \
  --output model-eval-results/harness.json
```

The evaluator checkpoints atomically after every case. Resume an interrupted
run with the same arguments plus `--resume`. It never terminates other Ollama
processes: it waits for an empty runner set and aborts if another model remains
loaded. Each artifact records exact prompts and hashes, raw responses, semantic
scores, timings, model digests, Ollama and Node versions, machine characteristics,
the evaluator-source hash, Git revision, and dirty-worktree state.

Keep the machine otherwise idle. Do not launch a second Ollama model workload
during a run; that invalidates latency comparisons and causes the isolation
check to stop the evaluator between model blocks.
