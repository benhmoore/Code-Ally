#!/usr/bin/env bash
#
# ally-lab — run a real, shared, observable ally session in tmux.
#
# The session runs the same `ally` binary and profile as a normal terminal
# run (npm link), inside a tmux session that a human and an agent can watch
# and drive at the same time.
#
# Human entry points (full interactive TUI, exactly like running ally):
#   ally-lab run --dir ~/minecraft-clone       # launch + land in the TUI
#   tmux attach -t ally-lab                               # (re)join a running lab
#   Detach with C-b d — ally keeps running.
#
# Agent entry points:
#   ally-lab start --dir ~/minecraft-clone     # launch detached
#   ally-lab hook [tmux-session]               # adopt a session the human started
#   ally-lab say "Build a minecraft clone..."  # send a message
#   ally-lab peek 80                           # read the rendered screen
#   ally-lab status                            # structured session state
#   ally-lab transcript 10                     # last N transcript entries
#   ally-lab key escape                        # interrupt the turn
#   ally-lab dump                              # write a /debug dump
#   ally-lab stop                              # end the session
#   ally-lab reset [--adopt]                   # wipe the experiment dir for a clean run
#                                              #   (only dirs marked .ally-lab-experiment)

set -euo pipefail

SESSION="${ALLY_LAB_SESSION:-ally-lab}"
STATE_DIR="${TMPDIR:-/tmp}/ally-lab"
DIR_FILE="$STATE_DIR/$SESSION.dir"

die() { echo "ally-lab: $*" >&2; exit 1; }
need_session() {
  tmux has-session -t "$SESSION" 2>/dev/null || die "no tmux session '$SESSION' (run: $0 start)"
}

cmd_start() {
  local dir="$PWD" fresh=0 manual=0 extra=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dir) dir="$2"; shift 2 ;;
      --fresh) fresh=1; shift ;;
      --manual) manual=1; shift ;;
      --) shift; extra=("$@"); break ;;
      *) die "unknown start option: $1 (ally flags go after --)" ;;
    esac
  done
  # Labs run unattended stretches; a permission prompt silently stalls the
  # experiment. Auto-confirm by default; pass --manual to keep prompts.
  [[ $manual -eq 0 ]] && extra=(--auto-confirm "${extra[@]}")
  dir="$(cd "$dir" && pwd)" || die "bad --dir"
  command -v ally >/dev/null || die "ally not on PATH"
  command -v tmux >/dev/null || die "tmux not installed"

  if tmux has-session -t "$SESSION" 2>/dev/null; then
    if [[ $fresh -eq 1 ]]; then tmux kill-session -t "$SESSION"; else
      die "session '$SESSION' already running (use --fresh to replace, or: tmux attach -t $SESSION)"
    fi
  fi
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$dir" > "$DIR_FILE"

  # A wide pane so the Ink UI renders the way it does in a real terminal.
  tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$dir" \
    "ally ${extra[*]:-}; echo; echo '[ally exited — press enter to close]'; read"
  # Let whichever client attaches drive the pane size, so a human joining with
  # a smaller terminal sees the whole UI instead of a cropped 200x50 region.
  tmux set-option -t "$SESSION" window-size latest 2>/dev/null || true
  echo "started tmux session '$SESSION' running ally in $dir"
  [[ ${#extra[@]} -gt 0 ]] && echo "extra ally args: ${extra[*]}"
  echo "watch it live:  tmux attach -t $SESSION   (detach with C-b d)"
}

cmd_run() {
  cmd_start "$@"
  exec tmux attach -t "$SESSION"
}

# Adopt a tmux session the human started themselves (e.g. `tmux new -s ally-lab`
# then running `ally` inside it). Records its pane's working directory so
# status/transcript resolve the right session files.
cmd_hook() {
  local name="${1:-$SESSION}"
  tmux has-session -t "$name" 2>/dev/null || die "no tmux session '$name' to hook"
  SESSION="$name"
  mkdir -p "$STATE_DIR"
  tmux display-message -p -t "$name" '#{pane_current_path}' > "$STATE_DIR/$name.dir"
  echo "hooked tmux session '$name' (dir: $(cat "$STATE_DIR/$name.dir"))"
  [[ "$name" != "${ALLY_LAB_SESSION:-ally-lab}" ]] \
    && echo "note: export ALLY_LAB_SESSION=$name for subsequent commands"
}

cmd_say() {
  need_session
  [[ $# -ge 1 ]] || die "usage: $0 say \"message\""
  # -l sends the text literally (no key-name interpretation), then Enter.
  tmux send-keys -t "$SESSION" -l "$1"
  sleep 0.2
  tmux send-keys -t "$SESSION" Enter
}

cmd_key() {
  need_session
  [[ $# -ge 1 ]] || die "usage: $0 key <escape|enter|C-c|...>"
  local name="$1"
  [[ "$name" == "escape" ]] && name="Escape"
  [[ "$name" == "enter" ]] && name="Enter"
  tmux send-keys -t "$SESSION" "$name"
}

cmd_peek() {
  need_session
  local lines="${1:-60}"
  tmux capture-pane -p -t "$SESSION" -S "-$lines"
}

latest_session_file() {
  local dir
  dir="$(cat "$DIR_FILE" 2>/dev/null || true)"
  python3 - "$dir" <<'PY'
import glob, json, os, sys
want_dir = sys.argv[1] if len(sys.argv) > 1 else ""
candidates = sorted(
    glob.glob(os.path.expanduser("~/.ally/projects/*/sessions/session_*.json")),
    key=os.path.getmtime, reverse=True)
fallback = None
for path in candidates:
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception:
        continue
    if fallback is None:
        fallback = path
    if not want_dir or data.get("working_dir") == want_dir:
        print(path)
        break
else:
    # No session matches the recorded dir (e.g. hooked pane cd'd after launch):
    # fall back to the newest session on disk.
    if fallback:
        print(fallback)
PY
}

cmd_status() {
  local file
  file="$(latest_session_file)"
  [[ -n "$file" ]] || die "no session file found for the lab directory yet"
  python3 - "$file" <<'PY'
import json, os, sys
path = sys.argv[1]
with open(path) as f:
    d = json.load(f)
messages = d.get("messages", [])
tail = d.get("transcript_tail", []) or []
meta = d.get("metadata", {}) or {}
checkpoint = meta.get("checkpoint") or d.get("checkpoint")
print(f"session:      {d.get('id')}")
print(f"file:         {path}")
print(f"working_dir:  {d.get('working_dir')}")
print(f"updated_at:   {d.get('updated_at')}")
print(f"active msgs:  {len(messages)}   transcript tail: {len(tail)}")
if isinstance(checkpoint, dict):
    print(f"checkpoint:   generation {checkpoint.get('generation')} "
          f"({checkpoint.get('strategy')}, {checkpoint.get('portability')})")
evicted = sum(1 for m in messages if (m.get("metadata") or {}).get("contentEvicted"))
if evicted:
    print(f"evicted:      {evicted} tool result(s) stubbed in active window")
last = messages[-1] if messages else None
if last:
    preview = (last.get("content") or "").replace("\n", " ")[:160]
    print(f"last message: [{last.get('role')}] {preview}")
PY
}

cmd_transcript() {
  local count="${1:-10}" file
  file="$(latest_session_file)"
  [[ -n "$file" ]] || die "no session file found for the lab directory yet"
  python3 - "$file" "$count" <<'PY'
import json, sys
path, count = sys.argv[1], int(sys.argv[2])
with open(path) as f:
    d = json.load(f)
entries = (d.get("transcript_tail") or d.get("messages") or [])[-count:]
for m in entries:
    role = m.get("role", "?")
    flags = []
    if (m.get("metadata") or {}).get("contentEvicted"): flags.append("evicted")
    if (m.get("metadata") or {}).get("isConversationCheckpoint"): flags.append("checkpoint")
    if m.get("is_error"): flags.append("error")
    tag = f" ({','.join(flags)})" if flags else ""
    body = (m.get("content") or "").replace("\n", " ")[:200]
    calls = m.get("tool_calls") or []
    call_note = " -> " + ", ".join(c["function"]["name"] for c in calls) if calls else ""
    print(f"[{role}{tag}]{call_note} {body}")
PY
}

cmd_dump() {
  need_session
  cmd_say "/debug dump"
  sleep 2
  ls -t "$HOME"/codeally-debug-*.txt 2>/dev/null | head -1
}

cmd_stop() {
  need_session
  tmux kill-session -t "$SESSION"
  echo "stopped '$SESSION'"
}

# Wipe the lab project directory for a clean experiment run. Refuses unless the
# directory carries the .ally-lab-experiment marker, so an agent with reset
# authority can never clear a directory a human did not explicitly designate.
# `reset --adopt` designates the current lab directory (writes the marker).
cmd_reset() {
  local adopt=0
  [[ "${1:-}" == "--adopt" ]] && adopt=1
  local dir
  dir="$(cat "$DIR_FILE" 2>/dev/null || true)"
  [[ -n "$dir" && -d "$dir" ]] || die "no recorded lab directory (run start/hook first)"
  case "$dir" in
    "$HOME"|"$HOME/"|/|/Users|/Users/) die "refusing to reset '$dir'" ;;
  esac
  if [[ ! -f "$dir/.ally-lab-experiment" ]]; then
    [[ $adopt -eq 1 ]] || die "'$dir' is not marked as an experiment dir (use: $0 reset --adopt to designate it)"
  fi
  tmux kill-session -t "$SESSION" 2>/dev/null && echo "stopped '$SESSION'"
  find "$dir" -mindepth 1 -maxdepth 1 ! -name '.ally-lab-experiment' -exec rm -rf {} +
  touch "$dir/.ally-lab-experiment"
  echo "reset experiment dir: $dir"
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  run) shift; cmd_run "$@" ;;
  hook) shift; cmd_hook "$@" ;;
  say) shift; cmd_say "$@" ;;
  key) shift; cmd_key "$@" ;;
  peek) shift; cmd_peek "$@" ;;
  status) cmd_status ;;
  transcript) shift; cmd_transcript "$@" ;;
  dump) cmd_dump ;;
  stop) cmd_stop ;;
  reset) shift; cmd_reset "$@" ;;
  *) grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed -n '2,24p'; exit 1 ;;
esac
