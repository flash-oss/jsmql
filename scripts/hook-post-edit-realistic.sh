#!/bin/sh
# This is the hook glue for .claude/settings.json's PostToolUse hook.
#
# After an Edit or Write tool call, Claude Code sends a JSON payload to this script through
# stdin. The payload holds the tool name and its inputs. This script reads tool_input.file_path
# from that payload. Assume the changed file is test/realistic.test.ts, which drives the
# examples manifest, or playground_skeleton.html, the playground UI source. In both cases,
# this script runs the playground sync script, which regenerates playground.html. In every
# other case, this script exits with status 0 and prints nothing.
#
# This script needs jq. jq is already on the project's permissions allow list.
set -eu
file=$(jq -r '.tool_input.file_path // ""' 2>/dev/null || true)
case "$file" in
  *test/realistic.test.ts | *playground_skeleton.html)
    exec node "${CLAUDE_PROJECT_DIR:-.}/scripts/sync-playground.mjs"
    ;;
esac
