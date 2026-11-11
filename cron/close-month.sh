#!/usr/bin/env bash
# Cron entry point for the daily monthly-close check (close-month.js --due).
#
# crontab (nuno@echo) - echo's system TZ is UTC and Ubuntu's cron doesn't
# reliably support CRON_TZ, so the schedule is pinned in UTC. 09:00 UTC is
# 09:00 Lisbon in winter and 10:00 in summer, which is fine for a morning
# reminder; close-month.js itself works out "today" in Europe/Lisbon:
#   0 9 * * * /home/nuno/oscar/cron/close-month.sh
#
# Shares poll-inbox.sh's lock file on purpose: both run the month pipeline
# (xlsx, close.json) and must never overlap. Unlike poll-inbox (skips if busy,
# retries in 10 min) this waits up to 15 minutes for it, because it only runs
# once a day.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs
exec 9>logs/.poll-inbox.lock
flock -w 900 9 || { echo "$(date -Is) skipped: lock busy for 15 min" >> logs/close-month.log; exit 0; }
{ echo "--- $(date -Is)"; } >> logs/close-month.log
exec /usr/bin/node close-month.js --due >> logs/close-month.log 2>> logs/close-month.error.log
