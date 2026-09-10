#!/bin/sh
# PreToolUse Bash hook for sentinel triage sessions.
# Deterministically blocks anything that could publish work to a remote:
# fix branches are local-only, reviewed and merged by a human.
exec /usr/bin/env node -e "
let raw = \"\";
process.stdin.on(\"data\", (d) => (raw += d)).on(\"end\", () => {
  let cmd = \"\";
  try { cmd = JSON.parse(raw).tool_input?.command ?? \"\"; } catch { process.exit(0); }
  const banned = [
    /\bgit\b[^\n|;&]*\bpush\b/,
    /\bgit\b[^\n|;&]*\bremote\b\s+(add|set-url)/,
    /\bgh\s/,
    /\b(curl|wget)\b[^\n]*git\.engr\.msstate\.edu/,
  ];
  if (banned.some((re) => re.test(cmd))) {
    console.error(\"sentinel: remote-publishing commands are blocked in triage sessions; fix branches stay local\");
    process.exit(2);
  }
  process.exit(0);
});
"
