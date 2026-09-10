#!/bin/sh
# A PreToolUse guard of the shape hooks are written in for Claude Code: it
# reads tool_input.command from the JSON payload on stdin and exits 2 with the
# reason on stderr. Used to prove that format runs here unmodified.
exec /usr/bin/env node -e "
let raw = \"\";
process.stdin.on(\"data\", (d) => (raw += d)).on(\"end\", () => {
  let cmd = \"\";
  try { cmd = JSON.parse(raw).tool_input?.command ?? \"\"; } catch { process.exit(0); }
  const banned = [
    /\bgit\b[^\n|;&]*\bpush\b/,
    /\bgit\b[^\n|;&]*\bremote\b\s+(add|set-url)/,
    /\bgh\s/,
  ];
  if (banned.some((re) => re.test(cmd))) {
    console.error(\"remote-publishing commands are blocked in this session; branches stay local\");
    process.exit(2);
  }
  process.exit(0);
});
"
