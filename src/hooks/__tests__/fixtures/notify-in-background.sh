#!/bin/sh
# PreToolUse hook that leaves work running after it returns, the shape a
# notifier or a cache warmer takes. The child inherits the hook's stdout and
# stderr, so those pipes stay open long after the hook itself has exited.
echo '{"systemMessage":"notified"}'
sleep 30 &
exit 0
