#!/usr/bin/env python3
"""Reproduce task/modal UX against loopback fixture using an isolated tmux socket/profile."""

import argparse
import json
import pathlib
import random
import shlex
import subprocess
import time

BASE = pathlib.Path("/tmp/ally-ux-tasks")
SOCKET = "ally-ux-tasks"
ENDPOINT = "http://127.0.0.1:11437"
CLI = pathlib.Path(__file__).resolve().parents[1] / "dist/cli.js"


def tm(*args):
    return subprocess.check_output(
        ["tmux", "-L", SOCKET, *args], text=True, stderr=subprocess.STDOUT
    )


def key(*keys):
    for event in keys:
        tm("send-keys", "-t", "ux", event)
        time.sleep(0.2)


def text(value):
    tm("send-keys", "-t", "ux", "-l", value)


def capture(label):
    time.sleep(0.35)
    value = tm("capture-pane", "-p", "-S", "-", "-t", "ux")
    (BASE / (label + ".txt")).write_text(value)
    (BASE / (label + "-visible.txt")).write_text(tm("capture-pane", "-p", "-t", "ux"))
    return value


def start():
    BASE.mkdir(exist_ok=True)
    data = BASE / "data"
    work = pathlib.Path("/tmp/ally-ux-conversation/workspace")
    work.mkdir(parents=True, exist_ok=True)
    config = data / "profiles/default/config.json"
    config.parent.mkdir(parents=True, exist_ok=True)
    (config.parent / "profile.json").write_text(
        json.dumps(
            dict(
                name="default",
                description="Isolated UX fixture",
                created_at="2026-01-01T00:00:00Z",
                updated_at="2026-01-01T00:00:00Z",
                metadata=dict(color="yellow"),
            )
        )
    )
    config.write_text(
        json.dumps(
            dict(
                provider="ollama",
                endpoint=ENDPOINT,
                model="ux-fuzz:latest",
                service_model="ux-fuzz:latest",
                setup_completed=True,
                enable_session_title_generation=False,
            )
        )
    )
    try:
        tm("kill-server")
    except subprocess.CalledProcessError:
        pass
    cmd = (
        "cd "
        + shlex.quote(str(work))
        + " && ALLY_DATA_DIR="
        + shlex.quote(str(data))
        + " node "
        + shlex.quote(str(CLI))
        + "; sleep 10"
    )
    tm("new-session", "-d", "-s", "ux", "-x", "80", "-y", "24", cmd)
    time.sleep(3)
    capture("startup")


def prompt(value):
    key("C-u")
    text(value)
    key("Enter")
    time.sleep(2)


def run(seed=1108):
    random.seed(seed)
    for w, h in [(80, 24), (40, 12)]:
        prefix = f"{w}x{h}"
        for marker in [
            "question",
            "freeform",
            "permission",
            "parallel",
            "message",
            "background",
            "foreground",
            "timeout",
            "tool-error",
            "command-error",
        ]:
            start()
            tm("resize-window", "-t", "ux", "-x", str(w), "-y", str(h))
            prompt("UX:" + marker)
            capture(prefix + "-" + marker + "-open")
            if marker == "question":
                for event in random.sample(["Down", "Up", "Tab"], 3):
                    key(event)
                key("Enter")
                time.sleep(1)
                capture(prefix + "-" + marker + "-answer")
            elif marker == "freeform":
                text("fixture café 界")
                key("Enter")
                time.sleep(1)
                capture(prefix + "-" + marker + "-answer")
            elif marker == "permission":
                key("Escape")
                capture(prefix + "-" + marker + "-cancel")
            elif marker == "foreground":
                key("C-b")
                time.sleep(1)
                capture(prefix + "-" + marker + "-ctrlb")
            elif marker == "parallel":
                key("Down", "Down", "Enter")
                capture(prefix + "-parallel-child-active")
                key("Escape")
                key("Down", "Down", "Down", "Down", "x")
                capture(prefix + "-parallel-child-cancelled")
                key("Up", "Up", "Up", "Enter", "Escape")
                time.sleep(8)
                capture(prefix + "-parallel-settled")
            elif marker == "message":
                time.sleep(10)
                capture(prefix + "-" + marker + "-settled")
            elif marker == "timeout":
                time.sleep(6)
                capture(prefix + "-" + marker + "-settled")
            else:
                time.sleep(3)
                capture(prefix + "-" + marker + "-settled")
            time.sleep(0.4)
    capture("end")
    expected = {
        "question": "Fixture choice",
        "freeform": "Fixture text",
        "permission": "permission-demo",
        "parallel": "Fixture parallel",
        "message": "Fixture messenger",
        "background": "bounded fixture",
        "foreground": "foreground",
        "timeout": "timeout",
        "tool-error": "intentionally-missing",
        "command-error": "failure",
    }
    results = []
    for w, h in [(80, 24), (40, 12)]:
        for marker, needle in expected.items():
            path = BASE / (f"{w}x{h}-{marker}-open.txt")
            screen = path.read_text() if path.exists() else ""
            results.append(
                {
                    "size": f"{w}x{h}",
                    "marker": marker,
                    "expected": needle,
                    "observed": needle.lower() in screen.lower(),
                    "capture": str(path),
                }
            )
    (BASE / "coverage.json").write_text(json.dumps(results, indent=2))
    print(
        json.dumps(
            {
                "artifact_directory": str(BASE),
                "seed": seed,
                "observed": sum(r["observed"] for r in results),
                "total": len(results),
            }
        )
    )


def command_pass():
    for w, h in [(80, 24), (40, 12)]:
        prefix = f"{w}x{h}"
        for marker in [
            "background",
            "foreground",
            "timeout",
            "command-error",
            "tool-error",
            "permission",
            "question",
        ]:
            start()
            tm("resize-window", "-t", "ux", "-x", str(w), "-y", str(h))
            prompt("UX:" + marker)
            capture(prefix + "-" + marker + "-pending")
            if marker == "question":
                key("Escape")
                time.sleep(1)
                capture(prefix + "-question-cancelled")
                continue
            if marker == "permission":
                key("BTab")
                capture(prefix + "-permission-mode")
                key("Enter")
                time.sleep(1)
                capture(prefix + "-permission-allowed")
                continue
            key("Enter")
            time.sleep(0.5)
            capture(prefix + "-" + marker + "-executing")
            if marker == "foreground":
                if w == 80:
                    key("C-b")
                else:
                    text("UX:markdown")
                    tm(
                        "send-keys",
                        "-t",
                        "ux",
                        "-H",
                        "1b",
                        "5b",
                        "31",
                        "33",
                        "3b",
                        "35",
                        "75",
                    )
                capture(prefix + "-foreground-backgrounded")
            time.sleep(7 if marker in ["foreground", "timeout"] else 3)
            capture(prefix + "-" + marker + "-finished")
    print(json.dumps({"command_pass_complete": True, "artifacts": str(BASE)}))


def fleet_pass():
    for w, h in [(80, 24), (40, 12)]:
        start()
        tm("resize-window", "-t", "ux", "-x", str(w), "-y", str(h))
        prefix = f"{w}x{h}"
        text("UX:parallel")
        key("Enter")
        time.sleep(1)
        capture(prefix + "-fleet-pending")
        key("Down", "Down", "Down", "Enter")
        capture(prefix + "-fleet-active-child")
        key("x")
        capture(prefix + "-fleet-cancelled-child")
        key("Up", "Up", "Up", "Enter")
        capture(prefix + "-fleet-main-return")
        time.sleep(7)
        capture(prefix + "-fleet-completed")
        key("Down", "Down", "Enter")
        capture(prefix + "-fleet-completed-child")
        key("Up", "Enter", "Escape")
        start()
        tm("resize-window", "-t", "ux", "-x", str(w), "-y", str(h))
        prompt("UX:message")
        time.sleep(5)
        capture(prefix + "-message-bidirectional")
    print(json.dumps({"fleet_pass_complete": True, "artifacts": str(BASE)}))


def final_pass():
    for w, h in [(40, 12), (80, 24)]:
        prefix = f"{w}x{h}"
        for marker in ["freeform", "delegate-fail", "message"]:
            start()
            tm("resize-window", "-t", "ux", "-x", str(w), "-y", str(h))
            prompt("UX:" + marker)
            if marker == "freeform":
                capture(prefix + "-final-freeform-open")
                text("final café 界")
                key("Enter")
                time.sleep(1)
                capture(prefix + "-final-freeform-answer")
            elif marker == "delegate-fail":
                time.sleep(3)
                capture(prefix + "-failed-child-main")
                key("Down", "Down", "Enter")
                capture(prefix + "-failed-child-view")
                key("Up", "Enter")
                capture(prefix + "-failed-child-return")
            else:
                time.sleep(6)
                capture(prefix + "-final-message-bidirectional")
    print(json.dumps({"final_pass_complete": True, "artifacts": str(BASE)}))


def plan_pass(sizes=None):
    outcomes = []
    for w, h in sizes or [(80, 24), (40, 12)]:
        for action in ["approve", "deny", "feedback"]:
            prefix = f"{w}x{h}-plan-{action}"
            start()
            tm("resize-window", "-t", "ux", "-x", str(w), "-y", str(h))
            text("UX:plan")
            key("Enter")
            screen = ""
            for _ in range(60):
                time.sleep(0.2)
                screen = tm("capture-pane", "-p", "-S", "-", "-t", "ux")
                if (
                    "Permission · write-plan" in screen
                    and "Plan ready for review" not in screen
                ):
                    key("Enter")
                if "Plan ready for review" in screen or all(
                    label in screen
                    for label in ["Approve + compact context", "Provide feedback..."]
                ):
                    break
            capture(prefix + "-open")
            opened = "Plan ready for review" in screen or all(
                label in screen
                for label in ["Approve + compact context", "Provide feedback..."]
            )
            if opened:
                if action == "approve":
                    key("Enter")
                elif action == "deny":
                    key("Escape")
                else:
                    key("Down", "Down", "Enter")
                    capture(prefix + "-empty-feedback")
                    text("Keep the fixture scope bounded.")
                    capture(prefix + "-feedback-edit")
                    key("Enter")
                time.sleep(1.5)
                capture(prefix + "-result")
            outcomes.append(
                {"size": f"{w}x{h}", "action": action, "modal_observed": opened}
            )
    (BASE / "plan-observed-results.json").write_text(json.dumps(outcomes, indent=2))
    print(json.dumps(outcomes))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--seed", type=int, default=1108)
    p.add_argument("--endpoint", default=ENDPOINT)
    p.add_argument("--start-only", action="store_true")
    p.add_argument("--commands", action="store_true")
    p.add_argument("--fleet", action="store_true")
    p.add_argument("--final", action="store_true")
    p.add_argument("--plans", action="store_true")
    a = p.parse_args()
    ENDPOINT = a.endpoint
    if a.start_only:
        start()
    elif a.commands:
        command_pass()
    elif a.fleet:
        fleet_pass()
    elif a.final:
        final_pass()
    elif a.plans:
        plan_pass()
    else:
        run(a.seed)
