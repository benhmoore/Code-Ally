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
#                  [--chat]                    # opt out of durable completion
#   ally-lab hook [tmux-session]               # adopt a session the human started
#   ally-lab say "Build a minecraft clone..."  # send a message
#   ally-lab peek 80                           # read the rendered screen
#   ally-lab status                            # structured session state
#   ally-lab transcript 10                     # last N transcript entries
#   ally-lab key escape                        # interrupt the turn
#   ally-lab dump                              # write a /debug dump
#   ally-lab stop                              # end the session
#   ally-lab reset [--dir PATH] [--adopt]      # wipe the experiment dir for a clean run
#                                              #   (only dirs marked .ally-lab-experiment)

set -euo pipefail

# Resolve through npm-link/Homebrew symlinks so companion scripts are found
# relative to the checked-out package, not the entry point in /opt/homebrew/bin.
SCRIPT_SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_SOURCE" ]]; do
  SOURCE_DIR="$(cd -P "$(dirname "$SCRIPT_SOURCE")" && pwd)"
  SCRIPT_SOURCE="$(readlink "$SCRIPT_SOURCE")"
  [[ "$SCRIPT_SOURCE" != /* ]] && SCRIPT_SOURCE="$SOURCE_DIR/$SCRIPT_SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_SOURCE")" && pwd)"

SESSION="${ALLY_LAB_SESSION:-ally-lab}"
STATE_DIR="${TMPDIR:-/tmp}/ally-lab"
DIR_FILE="$STATE_DIR/$SESSION.dir"
START_FILE="$STATE_DIR/$SESSION.started"
SESSION_ID_FILE="$STATE_DIR/$SESSION.session"

die() { echo "ally-lab: $*" >&2; exit 1; }
need_session() {
  tmux has-session -t "$SESSION" 2>/dev/null || die "no tmux session '$SESSION' (run: $0 start)"
}

stop_session() {
  tmux has-session -t "$SESSION" 2>/dev/null || return 0
  local pane_pid pane_dead i
  pane_pid="$(tmux display-message -p -t "$SESSION" '#{pane_pid}' 2>/dev/null || true)"

  # The pane command execs Ally, so pane_pid is the owning process itself.
  # Signal it while the PTY is still open, allowing Ally to flush state and
  # terminate every supervised background process before tmux tears down I/O.
  if [[ "$pane_pid" =~ ^[0-9]+$ ]]; then
    kill -HUP "$pane_pid" 2>/dev/null || true
    for ((i = 0; i < 100; i++)); do
      pane_dead="$(tmux display-message -p -t "$SESSION" '#{pane_dead}' 2>/dev/null || echo 1)"
      [[ "$pane_dead" == 1 ]] && break
      sleep 0.1
    done
    if [[ "${pane_dead:-0}" != 1 ]]; then
      kill -KILL "$pane_pid" 2>/dev/null || true
    fi
  fi
  tmux kill-session -t "$SESSION" 2>/dev/null || true
}

cmd_start() {
  local dir="$PWD" fresh=0 manual=0 durable=1 extra=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dir) dir="$2"; shift 2 ;;
      --fresh) fresh=1; shift ;;
      --manual) manual=1; shift ;;
      --chat) durable=0; shift ;;
      --) shift; extra=("$@"); break ;;
      *) die "unknown start option: $1 (ally flags go after --)" ;;
    esac
  done
  # Labs run unattended stretches; a permission prompt silently stalls the
  # experiment. Auto-confirm by default; pass --manual to keep prompts.
  [[ $manual -eq 0 ]] && extra=(--auto-confirm "${extra[@]}")
  # A lab run is an objective evaluation by default. Keep the interactive TUI
  # and interjection channel, but require structured completion instead of
  # accepting unsupported final prose. Use --chat for conversational probes.
  [[ $durable -eq 1 ]] && extra=(--durable-objective "${extra[@]}")
  dir="$(cd "$dir" && pwd)" || die "bad --dir"
  command -v ally >/dev/null || die "ally not on PATH"
  command -v tmux >/dev/null || die "tmux not installed"

  if tmux has-session -t "$SESSION" 2>/dev/null; then
    if [[ $fresh -eq 1 ]]; then stop_session; else
      die "session '$SESSION' already running (use --fresh to replace, or: tmux attach -t $SESSION)"
    fi
  fi
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$dir" > "$DIR_FILE"
  python3 -c 'import time; print(time.time_ns())' > "$START_FILE"
  rm -f "$SESSION_ID_FILE"

  # A resumed session predates this process, so launch time cannot identify it.
  # Preserve the explicit CLI identity as the authoritative diagnostic target.
  # Fresh sessions remain discoverable by directory and launch time below.
  local i arg resumed_session=""
  for ((i = 0; i < ${#extra[@]}; i++)); do
    arg="${extra[i]}"
    case "$arg" in
      --resume=*) resumed_session="${arg#--resume=}" ;;
      --resume)
        if ((i + 1 < ${#extra[@]})) && [[ "${extra[i + 1]}" != -* ]]; then
          resumed_session="${extra[i + 1]}"
        fi
        ;;
    esac
  done
  [[ -z "$resumed_session" ]] || printf '%s\n' "$resumed_session" > "$SESSION_ID_FILE"

  # A wide pane so the Ink UI renders the way it does in a real terminal.
  local ally_command
  printf -v ally_command '%q ' ally "${extra[@]}"
  tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$dir" "exec $ally_command"
  tmux set-option -t "$SESSION" remain-on-exit on
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
  # An adopted process may have started long before the hook. Directory matching
  # remains authoritative, but a launch-time boundary from an earlier managed
  # run must not hide its session file.
  rm -f "$STATE_DIR/$name.started"
  rm -f "$STATE_DIR/$name.session"
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
  local dir started_ns session_id
  dir="$(cat "$DIR_FILE" 2>/dev/null || true)"
  started_ns="$(cat "$START_FILE" 2>/dev/null || true)"
  session_id="$(cat "$SESSION_ID_FILE" 2>/dev/null || true)"
  python3 - "$dir" "$started_ns" "$session_id" <<'PY'
import glob, json, os, sys
want_dir = sys.argv[1] if len(sys.argv) > 1 else ""
started_ns = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else None
session_id = sys.argv[3] if len(sys.argv) > 3 else ""
candidates = sorted(
    glob.glob(os.path.expanduser("~/.ally/projects/*/sessions/session_*.json")),
    key=os.path.getmtime, reverse=True)
for path in candidates:
    if not session_id and started_ns is not None and os.stat(path).st_mtime_ns < started_ns:
        continue
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception:
        continue
    if session_id and data.get("id") != session_id:
        continue
    if not want_dir or data.get("working_dir") == want_dir:
        print(path)
        break
PY
}

cmd_status() {
  local file
  file="$(latest_session_file)"
  [[ -n "$file" ]] || die "no session file found for the lab directory yet"
  python3 "$SCRIPT_DIR/ally-lab-session.py" status "$file"
}

cmd_transcript() {
  local count="${1:-10}" file
  file="$(latest_session_file)"
  [[ -n "$file" ]] || die "no session file found for the lab directory yet"
  python3 "$SCRIPT_DIR/ally-lab-session.py" transcript "$file" "$count"
}

cmd_dump() {
  need_session
  cmd_say "/debug dump"
  sleep 2
  ls -t "$HOME"/codeally-debug-*.txt 2>/dev/null | head -1
}

cmd_stop() {
  need_session
  stop_session
  echo "stopped '$SESSION'"
}

# Wipe the lab project directory for a clean experiment run. Refuses unless the
# directory carries the .ally-lab-experiment marker, so an agent with reset
# authority can never clear a directory a human did not explicitly designate.
# `reset --adopt` designates the current lab directory (writes the marker).
cmd_reset() {
  local adopt=0
  local dir=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --adopt) adopt=1; shift ;;
      --dir) [[ $# -ge 2 ]] || die "--dir requires a path"; dir="$2"; shift 2 ;;
      *) die "unknown reset option: $1" ;;
    esac
  done
  [[ -n "$dir" ]] || dir="$(cat "$DIR_FILE" 2>/dev/null || true)"
  [[ -n "$dir" && -d "$dir" ]] || die "no lab directory available (pass: --dir PATH)"
  dir="$(cd "$dir" && pwd)" || die "bad --dir"
  case "$dir" in
    "$HOME"|"$HOME/"|/|/Users|/Users/) die "refusing to reset '$dir'" ;;
  esac
  if [[ ! -f "$dir/.ally-lab-experiment" ]]; then
    [[ $adopt -eq 1 ]] || die "'$dir' is not marked as an experiment dir (use: $0 reset --adopt to designate it)"
  fi
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    stop_session
    echo "stopped '$SESSION'"
  fi
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
