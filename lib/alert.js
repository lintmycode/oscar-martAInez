// Failure alerting for the unattended poller.
//
// poll-inbox.js runs headless under launchd every 10 minutes, so a failure
// is only ever visible in logs/poll-inbox.error.log - which is how an
// expired Gmail refresh token went unnoticed for 7 days and 516 failed
// runs. This surfaces failures on-screen instead.
//
// Two deliberate constraints:
//  - Only notify on a SUSTAINED failure, not the first one. Transient
//    blips (laptop asleep mid-run, a flaky DNS lookup) are normal for a
//    10-minute job and notifying on each would train you to ignore them.
//  - Only notify once per outage, not once per run, for the same reason.
import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { getDataRoot } from './paths.js';

// 3 consecutive failures ~= 30 minutes of a real outage at the current
// 10-minute StartInterval, which comfortably outlasts a closed laptop lid.
const FAILURE_THRESHOLD = 3;

const statePath = () => path.join(getDataRoot(), 'tmp', '.poll-health.json');

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

// osascript rather than a mail/webhook alert on purpose: the failures worth
// catching here (expired token, no API credits) need someone at this Mac to
// go fix them, and it adds no new credentials or outbound dependency that
// could itself be the thing that's broken.
function notify(title, message) {
  return new Promise((resolve) => {
    const esc = (s) => s.replace(/["\\]/g, '\\$&');
    execFile(
      'osascript',
      ['-e', `display notification "${esc(message)}" with title "${esc(title)}" sound name "Basso"`],
      () => resolve() // never let a failed notification mask the real failure
    );
  });
}

/**
 * Record that a run failed. Notifies once, on crossing the threshold.
 * @param {string} reason - short description shown in the notification
 */
export async function recordFailure(reason) {
  const state = await readState();
  state.consecutiveFailures += 1;
  state.lastFailure = new Date().toISOString();
  state.lastReason = reason;

  if (state.consecutiveFailures >= FAILURE_THRESHOLD && !state.notified) {
    await notify(
      'Oscar invoice intake is failing',
      `${state.consecutiveFailures} runs in a row: ${reason}`
    );
    state.notified = true;
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
