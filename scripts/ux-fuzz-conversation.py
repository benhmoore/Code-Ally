#!/usr/bin/env python3
"""Reproducible real-tmux conversation/editor smoke and seeded navigation fuzz.

Requires the local ux-fuzz-provider fixture. All application data is temporary.
Screens and exact event sequences are retained under --output.
"""

import argparse
import json
from pathlib import Path
import random
import shlex
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", default="/tmp/ally-ux-conversation")
parser.add_argument("--socket", default="ally-ux-conversation")
parser.add_argument("--seed", type=int, default=271828)
parser.add_argument("--events", type=int, default=160)
args = parser.parse_args()
out = Path(args.output).resolve()
out.mkdir(parents=True, exist_ok=True)
workspace = out / "workspace"
data = out / "data"
workspace.mkdir(exist_ok=True)
profile = data / "profiles/default"
profile.mkdir(parents=True, exist_ok=True)
config = dict(
    setup_completed=True,
    provider="ollama",
    endpoint="http://127.0.0.1:11435",
    model="ux-fuzz:latest",
    context_size=32768,
    permission_mode="manual",
    mouse_support="off",
)
if not (profile / "config.json").exists():
    (profile / "config.json").write_text(json.dumps(config))
(workspace / "README.md").write_text("# UX fixture\nTemporary test workspace.\n")
repo = Path(__file__).resolve().parent.parent
events = []
failures = []


def tmux(*params, check=True):
    return subprocess.run(
        ["tmux", "-L", args.socket, *params],
        check=check,
        text=True,
        capture_output=True,
    ).stdout


def screen():
    return tmux("capture-pane", "-p", "-t", "ux")


def capture(name):
    text = screen()
    (out / f"{len(events):04d}-{name}.txt").write_text(text)
    return text


def key(*keys):
    events.append({"keys": keys})
    tmux("send-keys", "-t", "ux", *keys)
    time.sleep(0.12)


def say(text):
    events.append({"text": text})
    tmux("send-keys", "-t", "ux", "-l", text)
    key("Enter")


def wait_for(label, predicate, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = screen()
        if predicate(value):
            capture(label)
            return value
        time.sleep(0.1)
    failures.append(label)
    capture(f"FAILED-{label}")
    return screen()


try:
    live = (
        subprocess.run(
            ["tmux", "-L", args.socket, "has-session", "-t", "ux"], capture_output=True
        ).returncode
        == 0
    )
    if not live:
        command = f'cd {shlex.quote(str(workspace))} && ALLY_DATA_DIR={shlex.quote(str(data))} node {shlex.quote(str(repo / "dist/cli.js"))}'
        tmux("new-session", "-d", "-s", "ux", "-x", "120", "-y", "36", command)
    wait_for("startup", lambda s: "Type a message" in s)
    for command in [
        "/help",
        "/debug",
        "/todo",
        "/memory",
        "/task list",
        "/run list",
        "/instructions",
        "/list-dir",
        "/focus",
        "/skill",
        "/mcp",
        "/schedule",
        "/agent active",
        "/config show context_size",
        "/config show changed",
    ]:
        say(command)
        time.sleep(0.3)
        capture("command-" + command.strip("/").replace(" ", "-"))
        key("Escape")
        time.sleep(0.3)
        key("C-u")
    say("UX:markdown")
    wait_for(
        "markdown-complete", lambda s: "Fixture complete." in s and "Ready" in s, 20
    )
    say("/rename UX deterministic session")
    time.sleep(0.4)
    capture("renamed")
    for width, height in [(80, 24), (40, 12), (120, 36)]:
        tmux("resize-window", "-t", "ux", "-x", str(width), "-y", str(height))
        time.sleep(0.25)
        tmux("send-keys", "-t", "ux", "-l", "draft café 界")
        capture(f"draft-{width}x{height}")
        key("Home", "Right", "End", "BSpace", "C-a", "C-e", "C-u")
    randomizer = random.Random(args.seed)
    choices = [
        "Up",
        "Down",
        "Left",
        "Right",
        "Home",
        "End",
        "Tab",
        "BTab",
        "Escape",
        "C-a",
        "C-e",
        "C-k",
        "C-u",
        "C-w",
        "PageUp",
        "PageDown",
    ]
    for index in range(args.events):
        if index % 20 == 0:
            tmux(
                "resize-window",
                "-t",
                "ux",
                "-x",
                str(randomizer.choice([40, 80, 120])),
                "-y",
                str(randomizer.choice([12, 24, 36])),
            )
        key(randomizer.choice(choices))
        if index % 10 == 0:
            capture(f"fuzz-{index:03d}")
        if tmux("display-message", "-p", "-t", "ux", "#{pane_dead}").strip() == "1":
            failures.append(f"process-exit-at-{index}")
            break
    # A deliberate double Escape opens rewind. Separate recovery from the last
    # random event so cleanup does not accidentally invoke that valid shortcut.
    time.sleep(0.4)
    key("Escape")
    time.sleep(0.35)
    key("C-u")
    tmux("send-keys", "-t", "ux", "-l", "FINAL-INPUT-READY")
    wait_for("input-recovered", lambda s: "FINAL-INPUT-READY" in s)
    key("C-e", "C-u")
    capture("final")
finally:
    (out / "events.json").write_text(
        json.dumps({"seed": args.seed, "events": events}, indent=2)
    )
    (out / "summary.json").write_text(
        json.dumps(
            {"seed": args.seed, "events": len(events), "failures": failures}, indent=2
        )
    )
print(json.dumps({"output": str(out), "events": len(events), "failures": failures}))
raise SystemExit(bool(failures))
