#!/usr/bin/env bash
# Appends a session-end summary of changed files to .claude/session.log.

LOG="$CLAUDE_PROJECT_DIR/.claude/session.log"
WRITES="$CLAUDE_PROJECT_DIR/.claude/writes.log"

echo "=== session ended $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$LOG"

if [ -f "$WRITES" ]; then
  echo "files written this session:" >> "$LOG"
  cat "$WRITES" >> "$LOG"
  # Reset for next session
  rm -f "$WRITES"
else
  echo "(no files written)" >> "$LOG"
fi

echo "" >> "$LOG"
exit 0
