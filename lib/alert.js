// Failure alerting for the unattended poller.
//
// poll-inbox.js runs headless every 10 minutes (cron on echo since
// 2026-11), so a failure is only ever visible in logs/poll-inbox.error.log -
// which is how an expired Gmail refresh token went unnoticed for 7 days and
// 516 failed runs, and an unmounted share for a month (10/10-11/11/2026,
// one macOS notification that nobody saw). This pushes failures to Telegram.
//
// Deliberate constraints:
//  - Only notify on a SUSTAINED failure, not the first one. Transient
//    blips (a flaky DNS lookup, the NAS waking up) are normal for a
//    10-minute job and notifying on each would train you to ignore them.
//  - Notify once per outage, then remind every REMIND_AFTER_MS while it
//    lasts - a single alert is easy to miss when you're away.
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';

// 3 consecutive failures ~= 30 minutes of a real outage at the 10-minute
// schedule.
const FAILURE_THRESHOLD = 3;
const REMIND_AFTER_MS = 24 * 60 * 60 * 1000;

// Kept in the project's local logs/, not the (shared, possibly unmounted)
// data root: this is per-machine poller health, and "share not mounted" is
// itself one of the failures it has to be able to record and alert on.
const statePath = () => path.join(process.cwd(), 'logs', '.poll-health.json');

// What to do about the failures seen so far, so the alert is actionable from
// a phone. invalid_grant = refresh token revoked/expired (7-day expiry while
// the OAuth consent screen is in Testing); re-auth needs a browser, so it is
// done on the laptop and the token copied over.
const HINTS = [
  [/invalid_grant/, 'Gmail login expired. On the laptop: npm run gmail:auth, then scp .gmail-token.json echo:oscar/'],
  [/data root .* not found/, 'echo.ops share not mounted on echo. Check: ls /mnt/echo-ops/oscar (autofs, NAS 192.168.1.2)'],
  [/could not be extracted/, 'OpenAI extraction failing - check API credits/key.'],
];

async function readState() {
  try {
    return JSON.parse(await fs.readFile(statePath(), 'utf8'));
  } catch {
    return { consecutiveFailures: 0, notified: false };
  }
}

async function writeState(state) {
  await fs.mkdir(path.dirname(statePath()), { recursive: true });
  await fs.writeFile(statePath(), JSON.stringify(state, null, 2));
}

// Beth's bot token is read from OpenClaw's config on echo, never copied into
// this repo's .env (same approach as sys/agents/uptime-probe.sh).
function telegramToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  try {
    const cfg = JSON.parse(readFileSync(path.join(os.homedir(), '.openclaw', 'openclaw.json'), 'utf8'));
    return cfg.channels?.telegram?.botToken || null;
  } catch {
    return null;
  }
}

async function notifyTelegram(title, message) {
  const token = telegramToken();
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error(`(no Telegram token/chat id - would send: ${title}: ${message})`);
    return;
  }
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: `${title}\n${message}`, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15000),
  });
}

// macOS notification for manual runs on the laptop; no credentials needed.
function notifyMac(title, message) {
  return new Promise((resolve) => {
    const esc = (s) => s.replace(/["\\]/g, '\\$&');
    execFile(
      'osascript',
      ['-e', `display notification "${esc(message)}" with title "${esc(title)}" sound name "Basso"`],
      () => resolve()
    );
  });
}

// Also used by poll-inbox.js for the per-run "invoices filed" summary.
export async function notify(title, message) {
  try {
    if (process.platform === 'darwin') await notifyMac(title, message);
    else await notifyTelegram(title, message);
  } catch (err) {
    // never let a failed notification mask the real failure
    console.error(`(alert failed: ${err.message})`);
  }
}

/**
 * Record that a run failed. Notifies on crossing the threshold, then again
 * every REMIND_AFTER_MS while the outage lasts.
 * @param {string} reason - short description shown in the notification
 */
export async function recordFailure(reason) {
  const state = await readState();
  state.consecutiveFailures += 1;
  state.lastFailure = new Date().toISOString();
  state.lastReason = reason;

  const dueReminder = state.notified && Date.now() - Date.parse(state.notifiedAt || 0) >= REMIND_AFTER_MS;
  if (state.consecutiveFailures >= FAILURE_THRESHOLD && (!state.notified || dueReminder)) {
    const hint = HINTS.find(([re]) => re.test(reason))?.[1];
    await notify(
      state.notified ? 'Oscar invoice intake STILL failing' : 'Oscar invoice intake is failing',
      `${state.consecutiveFailures} runs in a row: ${reason}${hint ? `\nFix: ${hint}` : ''}`
    );
    state.notified = true;
    state.notifiedAt = new Date().toISOString();
  }

  await writeState(state);
}

/**
 * Record that a run succeeded, clearing any outage and notifying recovery
 * only if we had actually alerted about it.
 */
export async function recordSuccess() {
  const state = await readState();
  if (state.consecutiveFailures === 0 && !state.notified) return;

  if (state.notified) {
    await notify('Oscar invoice intake recovered', 'Polling is working again.');
  }
  await writeState({ consecutiveFailures: 0, notified: false, lastSuccess: new Date().toISOString() });
}
