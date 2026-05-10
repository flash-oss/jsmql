#!/bin/sh
# Hook glue for .claude/settings.json's PostToolUse hook.
#
# After any Edit/Write tool call, Claude Code pipes a JSON payload to stdin
# with the tool name and inputs. This script extracts tool_input.file_path
# and, if the touched file is test/realistic.test.ts, runs the playground
# sync script. Otherwise exits 0 silently.
#
# Requires jq (already in the project's permissions allow-list).
set -eu
file=$(jq -r '.tool_input.file_path // ""' 2>/dev/null || true)
case "$file" in
  *test/realistic.test.ts)
    exec node "${CLAUDE_PROJECT_DIR:-.}/scripts/sync-playground.mjs"
    ;;
esac
