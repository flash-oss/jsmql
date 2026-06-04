#!/bin/sh
# Hook glue for .claude/settings.json's PostToolUse hook.
#
# After any Edit/Write tool call, Claude Code pipes a JSON payload to stdin
# with the tool name and inputs. This script extracts tool_input.file_path
# and, if the touched file is test/realistic.test.ts (drives the examples
# manifest) or playground_skeleton.html (the playground UI source), runs the
# playground sync script to regenerate playground.html. Otherwise exits 0
# silently.
#
# Requires jq (already in the project's permissions allow-list).
set -eu
file=$(jq -r '.tool_input.file_path // ""' 2>/dev/null || true)
case "$file" in
  *test/realistic.test.ts | *playground_skeleton.html)
    exec node "${CLAUDE_PROJECT_DIR:-.}/scripts/sync-playground.mjs"
    ;;
esac
