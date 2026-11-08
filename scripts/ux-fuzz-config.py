import subprocess
import time
import json
import pathlib
import sys
import shlex
import os

BASE = pathlib.Path(os.environ.get("ALLY_UX_CONFIG_DIR", "/tmp/ally-ux-config"))
SOCKET = os.environ.get("ALLY_UX_CONFIG_SOCKET", "ally-ux-config")
CLI = pathlib.Path(__file__).resolve().parents[1] / "dist/cli.js"


def tm(*a):
    return subprocess.check_output(["tmux", "-L", SOCKET, *a], text=True)


def capture(label):
    time.sleep(0.4)
    text = tm("capture-pane", "-p", "-S", "-", "-t", "ux")
    (BASE / (label + ".txt")).write_text(text)
    return text


def key(*keys):
    tm("send-keys", "-t", "ux", *keys)
    time.sleep(0.12)


def text(s):
    tm("send-keys", "-t", "ux", "-l", s)


def command(s):
    key("C-u")
    text(s)
    key("Enter")
    time.sleep(0.35)


def start(fresh=False):
    BASE.mkdir(parents=True, exist_ok=True)
    data = BASE / ("fresh-data" if fresh else "data")
    work = BASE / "work"
    work.mkdir(exist_ok=True)
    p = data / "profiles/default"
    p.mkdir(parents=True, exist_ok=True)
    if not (p / "profile.json").exists():
        (p / "profile.json").write_text(
            json.dumps(
                dict(
                    name="default",
                    created_at="2026-11-08T00:00:00.000Z",
                    updated_at="2026-11-08T00:00:00.000Z",
                    metadata=dict(color="yellow"),
                )
            )
        )
    if not (p / "config.json").exists():
        (p / "config.json").write_text(
            json.dumps(
                dict(
                    provider="ollama",
                    endpoint="http://127.0.0.1:"
                    + os.environ.get("ALLY_UX_PROVIDER_PORT", "11436"),
                    model="ux-fuzz:latest",
                    service_model="ux-fuzz:latest",
                    setup_completed=not fresh,
                    enable_session_title_generation=False,
                )
            )
        )
    cmd = (
        "cd "
        + shlex.quote(str(work))
        + " && ALLY_DATA_DIR="
        + shlex.quote(str(data))
        + " node "
        + shlex.quote(str(CLI))
        + " 2>"
        + shlex.quote(str(BASE / "stderr.log"))
    )
    tm("new-session", "-d", "-s", "ux", "-x", "120", "-y", "36", cmd)
    time.sleep(3)


def config_pass():
    for i, cmd in enumerate(
        [
            "/config",
            "/config show changed",
            "/config show context_size",
            "/config show nonsense",
            "/config set context_size=-1",
            "/config set context_size=NaN",
            "/config set temperature=garbage",
            "/config set stream_responses=maybe",
            "/config set madeup=1",
            "/config set context_size=8192",
            "/config show context_size",
            "/config reset context_size",
            "/config show context_size",
            "/config reset madeup",
            "/model",
            "/model service",
        ]
    ):
        command(cmd)
        capture(f"config-{i:02d}")
        if cmd in ["/model", "/model service"]:
            key("Down", "Up", "Escape")
            capture(f"config-{i:02d}-cancel")
    command("/prompt add")
    capture("prompt-empty")
    key("Enter")
    capture("prompt-empty-enter")
    text("題名 🦊")
    key("BTab")
    capture("prompt-shifttab")
    key("Escape")
    capture("prompt-cancel")
    command("/agent create")
    capture("agent-empty")
    key("Enter")
    capture("agent-empty-enter")
    text("Unicode 試験 🦊")
    key("Escape")
    capture("agent-cancel")
    command("/project init")
    capture("project-open")
    key("Enter")
    capture("project-name")
    key("C-u")
    text("試験 🦊")
    key("Escape")
    capture("project-back")
    key("C-c")
    capture("project-cancel")
    command("/config setup")
    capture("setup-provider")
    key("Enter")
    capture("setup-endpoint")
    key("C-u")
    text("invalid endpoint")
    key("Enter")
    capture("setup-endpoint-invalid")
    key("Escape")
    capture("setup-back")
    key("C-c")
    capture("setup-cancel")
    for size in [(80, 24), (40, 12), (120, 36)]:
        tm("resize-window", "-t", "ux", "-x", str(size[0]), "-y", str(size[1]))
        command("/prompt add")
        text("題名 🦊")
        key("Tab")
        text("Line one")
        key("Tab")
        text("tag")
        capture(f"prompt-{size[0]}x{size[1]}")
        key("Escape")
    capture("end")


def seeded_pass():
    import random

    rng = random.Random(20261108)
    for i in range(24):
        w, h = [(120, 36), (80, 24), (40, 12)][i % 3]
        tm("resize-window", "-t", "ux", "-x", str(w), "-y", str(h))
        cmd = [
            "/prompt add",
            "/agent create",
            "/project init",
            "/model",
            "/model service",
            "/config setup",
        ][i % 6]
        command(cmd)
        for _ in range(rng.randint(1, 5)):
            key(
                rng.choice(
                    ["Up", "Down", "Tab", "BTab", "Home", "End", "PageDown", "PageUp"]
                )
            )
        if i % 6 == 0:
            text("Unicode 試験 🦊")
        capture(f"seed-{i:02d}-open")
        if i % 6 == 5:
            key("C-c")
        else:
            key("Escape")
        capture(f"seed-{i:02d}-closed")
    print("24 seeded dialog cases completed")


def pairwise_pass():
    try:
        tm("kill-session", "-t", "ux")
    except:
        pass
    start()
    for width, height in [(40, 12), (80, 24)]:
        tm("resize-window", "-t", "ux", "-x", str(width), "-y", str(height))
        command("/project init")
        capture(f"pair-{width}-project-welcome")
        for step in [
            "name",
            "description",
            "language",
            "setup",
            "build",
            "test",
            "formatter",
            "linter",
            "complete",
        ]:
            key("Enter")
            capture(f"pair-{width}-project-{step}")
        key("Enter")
        command("/prompt add")
        text("題名 🦊")
        capture(f"pair-{width}-prompt-title")
        key("Tab")
        text("\n".join("INSPECT-" + str(i) for i in range(16)))
        capture(f"pair-{width}-prompt-end")
        for _ in range(18):
            key("Up")
        capture(f"pair-{width}-prompt-start")
        key("Tab")
        capture(f"pair-{width}-prompt-tags")
        key("Escape")
        command("/config setup")
        for step in [
            "provider",
            "endpoint",
            "credentials",
            "model",
            "context",
            "permissions",
            "review",
        ]:
            capture(f"pair-{width}-setup-{step}")
            key("Enter")
        capture(f"pair-{width}-setup-complete")
        key("Enter")
        command("/agent create")
        capture(f"pair-{width}-agent-empty")
        key("Enter")
        capture(f"pair-{width}-agent-validation")
        key("Escape")
    print("pairwise project/prompt/setup/agent entry completed")


def advanced_pass():
    def pane():
        return tm("capture-pane", "-p", "-t", "ux")

    def advance(needle):
        for i in range(3):
            key("Enter")
            time.sleep(0.3)
            if needle in pane():
                return
        raise RuntimeError("Did not reach " + needle + "\n" + pane())

    tm("kill-session", "-t", "ux")
    start()
    for width, height in [(40, 12), (80, 24)]:
        tm("resize-window", "-t", "ux", "-x", str(width), "-y", str(height))
        command("/agent create")
        text("A bounded helper for isolated UX fixture tests.")
        advance("Customize System Prompt")
        capture(f"advanced-{width}-system-prompt")
        advance("Customize Description")
        capture(f"advanced-{width}-description")
        advance("Customize Name")
        capture(f"advanced-{width}-name")
        key("C-u")
        text("Bad Name")
        key("Enter")
        capture(f"advanced-{width}-invalid-name")
        key("Down")
        text("RECOVER")
        capture(f"advanced-{width}-recovered-first-chunk")
        key("C-u")
        text("ux-agent-" + str(width))
        advance("Yes, customize model")
        capture(f"advanced-{width}-model-choice")
        advance("ux-fuzz:latest")
        capture(f"advanced-{width}-models")
        advance("All tools")
        capture(f"advanced-{width}-tools")
        key("Down")
        key("Down")
        key("Enter")
        capture(f"advanced-{width}-custom-tools")
        key("Down")
        key(" ")
        capture(f"advanced-{width}-custom-toggle")
        key("Enter")
        capture(f"advanced-{width}-confirm")
        key("Enter")
        capture(f"advanced-{width}-created")
        command("/agent show ux-agent-" + str(width))
        capture(f"advanced-{width}-persisted")
    print("advanced wizard pairwise completed")


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "help"
    if action == "start":
        start("fresh" in sys.argv)
        capture("startup")
    elif action == "config":
        config_pass()
    elif action == "seeded":
        seeded_pass()
    elif action == "pairwise":
        pairwise_pass()
    elif action == "advanced":
        advanced_pass()
    else:
        print(
            "Usage: ux-fuzz-config.py start [fresh] | config | seeded | pairwise | advanced; requires the fixture provider on 127.0.0.1:11436"
        )
