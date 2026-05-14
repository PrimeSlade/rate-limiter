#!/usr/bin/env bash
# Blocks destructive git commands before they execute.
# Claude Code passes the command as JSON on stdin: {"tool":"Bash","input":{"command":"..."}}

INPUT=$(cat)
CMD=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('input',{}).get('command',''))" 2>/dev/null)

if echo "$CMD" | grep -qE 'git\s+push\s+.*--force|git\s+reset\s+--hard|git\s+checkout\s+\.|git\s+restore\s+\.|git\s+clean\s+-f'; then
  echo "BLOCK: dangerous git command rejected: $CMD" >&2
  exit 2
fi

exit 0
