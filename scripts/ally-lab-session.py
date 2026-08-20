#!/usr/bin/env python3
"""Read the bounded, segmented session format used by ally-lab diagnostics."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
from typing import Any


def load_manifest(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError("session manifest must be a JSON object")
    return value


def transcript_parts(manifest: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    refs = manifest.get("transcript_segments") or []
    if not isinstance(refs, list):
        raise ValueError("transcript_segments must be an array")
    if refs:
        tail = manifest.get("transcript_tail") or []
    else:
        tail = manifest.get("transcript") or manifest.get("transcript_tail") or manifest.get("messages") or []
    if not isinstance(tail, list):
        raise ValueError("transcript tail must be an array")
    return refs, tail


def load_segment(session_path: Path, ref: dict[str, Any]) -> list[dict[str, Any]]:
    digest = ref.get("hash")
    count = ref.get("message_count")
    if not isinstance(digest, str) or not isinstance(count, int):
        raise ValueError("invalid transcript segment reference")
    segment_path = session_path.parent / session_path.stem / "transcript-segments" / f"{digest}.json"
    with segment_path.open(encoding="utf-8") as handle:
        segment = json.load(handle)
    messages = segment.get("messages") if isinstance(segment, dict) else None
    if not isinstance(messages, list):
        raise ValueError(f"transcript segment has no message array: {digest}")
    encoded = json.dumps(messages, ensure_ascii=False, separators=(",", ":"))
    actual = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    if segment.get("hash") != digest or len(messages) != count or actual != digest:
        raise ValueError(f"transcript segment failed integrity validation: {digest}")
    return messages


def recent_transcript(session_path: Path, manifest: dict[str, Any], count: int) -> list[dict[str, Any]]:
    if count < 0:
        raise ValueError("transcript count must be non-negative")
    refs, tail = transcript_parts(manifest)
    entries = list(tail)
    for ref in reversed(refs):
        if len(entries) >= count:
            break
        entries = load_segment(session_path, ref) + entries
    return entries[-count:] if count else []


def print_status(path: Path, manifest: dict[str, Any]) -> None:
    messages = manifest.get("messages") or []
    refs, tail = transcript_parts(manifest)
    archived = sum(ref.get("message_count", 0) for ref in refs if isinstance(ref, dict))
    total = archived + len(tail)
    meta = manifest.get("metadata") or {}
    checkpoint = meta.get("checkpoint") or manifest.get("checkpoint") or manifest.get("conversation_checkpoint")
    print(f"session:      {manifest.get('id')}")
    print(f"file:         {path}")
    print(f"working_dir:  {manifest.get('working_dir')}")
    print(f"updated_at:   {manifest.get('updated_at')}")
    print(f"active msgs:  {len(messages)}   transcript: {total} ({archived} archived + {len(tail)} tail)")
    if isinstance(checkpoint, dict):
        print(f"checkpoint:   generation {checkpoint.get('generation')} "
              f"({checkpoint.get('strategy')}, {checkpoint.get('portability')})")
    evicted = sum(1 for message in messages if (message.get("metadata") or {}).get("contentEvicted"))
    if evicted:
        print(f"evicted:      {evicted} tool result(s) stubbed in active window")
    compacted = sum(1 for message in messages if (message.get("metadata") or {}).get("toolArgumentsEvicted"))
    if compacted:
        print(f"compacted:    {compacted} completed tool call(s) carry bounded arguments")
    if messages:
        last = messages[-1]
        preview = (last.get("content") or "").replace("\n", " ")[:160]
        print(f"last message: [{last.get('role')}] {preview}")


def print_transcript(entries: list[dict[str, Any]]) -> None:
    for message in entries:
        role = message.get("role", "?")
        metadata = message.get("metadata") or {}
        flags = []
        if metadata.get("contentEvicted"):
            flags.append("evicted")
        if metadata.get("isConversationCheckpoint"):
            flags.append("checkpoint")
        if message.get("is_error"):
            flags.append("error")
        tag = f" ({','.join(flags)})" if flags else ""
        body = (message.get("content") or "").replace("\n", " ")[:200]
        calls = message.get("tool_calls") or []
        names = [call.get("function", {}).get("name", "?") for call in calls]
        call_note = " -> " + ", ".join(names) if names else ""
        print(f"[{role}{tag}]{call_note} {body}")


def main(argv: list[str]) -> int:
    if len(argv) < 3 or argv[1] not in {"status", "transcript"}:
        print("usage: ally-lab-session.py <status|transcript> SESSION_FILE [COUNT]", file=sys.stderr)
        return 2
    path = Path(argv[2])
    manifest = load_manifest(path)
    if argv[1] == "status":
        print_status(path, manifest)
    else:
        count = int(argv[3]) if len(argv) > 3 else 10
        print_transcript(recent_transcript(path, manifest, count))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"ally-lab: {error}", file=sys.stderr)
        raise SystemExit(1)
