#!/bin/sh
# agy PreToolUse hook (registered in ~/.gemini/config/hooks.json). Headless agy denies anything that
# needs approval, so in the desk's agy sessions this asks the runner (agy.ts) instead: the tool call
# goes to the session's approval server, which answers auto_approve or deny once the desk decides.
# Other agy sessions, e.g. the user's own terminal, lack the address and keep agy's default.
if [ -z "$AGENT_DESK_AGY_URL" ]; then
  cat >/dev/null
  exit 0
fi
curl -sSf --max-time 3660 -H "Authorization: Bearer $AGENT_DESK_AGY_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @- "$AGENT_DESK_AGY_URL" \
  || echo '{"decision":"deny","reason":"데스크 러너에 묻지 못해 거부했습니다"}'
exit 0
