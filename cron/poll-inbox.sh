#!/usr/bin/env bash
# Cron entry point for poll-inbox.js on echo (replaces the laptop's launchd job
# since 2026-11-11 - the laptop only reached the echo.ops share when someone
# mounted it by hand, so intake silently stopped for a month).
#
# crontab (nuno@echo):
#   */10 * * * * /home/nuno/oscar/cron/poll-inbox.sh
#
# flock: a run with a big backlog (OpenAI extraction per attachment) can take
# longer than 10 minutes; a second copy would download the same unread emails.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs
exec 9>logs/.poll-inbox.lock
flock -n 9 || { echo "$(date -Is) skipped: previous run still going" >> logs/poll-inbox.log; exit 0; }
{ echo "--- $(date -Is)"; } >> logs/poll-inbox.log
exec /usr/bin/node poll-inbox.js >> logs/poll-inbox.log 2>> logs/poll-inbox.error.log
