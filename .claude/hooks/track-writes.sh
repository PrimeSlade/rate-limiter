#!/usr/bin/env bash
# Appends every written/edited file path to .claude/writes.log for the session.

INPUT=$(cat)
FILE=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('input',{}).get('file_path',''))" 2>/dev/null)

if [ -n "$FILE" ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $FILE" >> "$CLAUDE_PROJECT_DIR/.claude/writes.log"
fi

exit 0
