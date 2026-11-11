// U3: the monthly close job. Used by close-month.js (cron + manual) and by
// poll-inbox.js (re-check right after it files something).
//
// Lifecycle of month M (state in M/close.json):
//   (none) --14th of M+1--> open --complete--> bundled
//                             `--20th of M+1, still incomplete--> bundled-incomplete
//   bundled / bundled-incomplete --close-month.js --rebundle--> bundled
import crypto from 'crypto';
import { createReadStream } from 'fs';
import { status } from './month-status.js';
import { readState, writeState, monthsWithStatus, assignNumbers } from './close-state.js';
import { deliverBundle } from './deliver-bundle.js';
import { say, isDryRun } from './notify-out.js';
import { addMonths, monthNameEn, today } from './months.js';

export const CLOSE_DAY = 14;     // start chasing M-1 on this day of M
export const DEADLINE_DAY = 20;  // accountant needs the bundle by this day of M

const shortDate = (d) => d.slice(0, 5); // 03/10/2026 -> 03/10
const MAX_LISTED = 30; // keep Telegram messages readable (see also notify-out.js)

/** Flatten a status() result into stable, id-keyed items (ids drive "N of M found"). */
function itemsOf(state, st) {
  const items = [];
  for (const m of st.extracts.missing) items.push({ id: m.id, kind: 'extract', text: m.text });
  // Invoices are only knowable once the extracts are in and the month has run.
  for (const inv of assignNumbers(state, st.missingInvoices)) {
    items.push({ id: `inv:${inv.num}`, kind: 'invoice', num: inv.num, text: `#${inv.num} ${shortDate(inv.date)} · ${inv.description} · ${Number(inv.amount).toFixed(2)}` });
  }
  for (const f of st.needsReview) items.push({ id: `rev:${f}`, kind: 'review', text: f });
  return items;
}

function buildMessage(month, items, prevMissing) {
  const first = !prevMissing;
  const found = prevMissing ? prevMissing.filter((id) => !items.some((i) => i.id === id)).length : 0;
  const name = monthNameEn(month);
  const title = first ? `Oscar: closing ${name}` : `Oscar: still missing for ${name}`;

  const lines = [];
  if (!first && found > 0) lines.push(`${found} of ${prevMissing.length} found since last time.`);

  const section = (kind) => {
    const list = items.filter((i) => i.kind === kind);
    const shown = list.slice(0, MAX_LISTED).map((i) => (kind === 'extract' ? `• ${i.text}` : i.kind === 'review' ? `• ${i.text}` : i.text));
    if (list.length > MAX_LISTED) shown.push(`…and ${list.length - MAX_LISTED} more`);
    return shown;
  };

  const ext = section('extract');
  if (ext.length) {
    lines.push(`${first ? 'Oscar needs for' : 'Still need for'} ${name}, the bank extracts:`, ...ext,
      'Email the CSVs to the intake inbox, or drop them in oscar/inbox/ on echo.ops.');
  }
  const inv = section('invoice');
  if (inv.length) {
    lines.push(`${ext.length ? '\n' : ''}No invoice yet for ${items.filter((i) => i.kind === 'invoice').length} company transaction(s):`, ...inv,
      'Email the invoices, or email "sem fatura" with the numbers (e.g. "3 anuidade cartão") for ones that will never have one.');
  }
  const rev = section('review');
  if (rev.length) {
    lines.push(`${lines.length ? '\n' : ''}Files in tmp/needs-review (no date found, move or delete them):`, ...rev);
  }
  return { title, text: lines.join('\n') };
}

async function sha256File(p) {
  const h = crypto.createHash('sha256');
  for await (const chunk of createReadStream(p)) h.update(chunk);
  return h.digest('hex');
}

async function deliver(month, state, st, items, { incomplete }) {
  const missing = items.map((i) => i.text);
  const res = await deliverBundle({ month, incomplete, missing, summary: st.summary });
  // A dry run delivers nothing, so the month must stay open: otherwise a
  // rehearsal would silently mark a real month as sent. Same when the email
  // failed (deliverBundle returns emailed:false and has already alerted on
  // Telegram) - the next daily run retries instead of the month going quiet.
  if (!isDryRun() && res?.emailed) {
    state.status = incomplete ? 'bundled-incomplete' : 'bundled';
    state.bundledAt = new Date().toISOString();
    if (res?.zipPath) { try { state.bundleSha = await sha256File(res.zipPath); } catch { /* zip not readable here */ } }
  }
  return res;
}

/**
 * Check one month and act on it.
 * @param {string} month YYYY-MM
 * @param {object} o
 * @param {'due'|'manual'|'poll'} o.trigger
 *   due    - daily cron: reminders throttled to once per day, applies the deadline
 *   manual - close-month.js --month: always prints/sends the current list
 *   poll   - right after poll-inbox filed something: bundles on completion, otherwise
 *            only speaks up when the missing list changed (the daily reminder covers the rest)
 * @param {boolean} [o.deadline] true on/after the 20th of M+1 (only meaningful for 'due')
 * @param {boolean} [o.rebundle] re-run and re-send even if already bundled
 * @returns {Promise<string>} outcome, for logging/tests
 */
export async function checkMonth(month, { trigger, deadline = false, rebundle = false }) {
  const now = today();
  const state = await readState(month);

  if (state.status && state.status.startsWith('bundled') && !rebundle) {
    console.log(`${month}: already ${state.status}; use --rebundle to send a fresh bundle.`);
    return state.status;
  }
  const justOpened = !state.status;
  if (!state.status) { state.status = 'open'; state.openedAt = new Date().toISOString(); }

  const st = await status(month, { force: rebundle });
  const items = itemsOf(state, st);

  // --- complete: hand over to U4 ---
  if (st.complete) {
    console.log(`${month}: complete, delivering bundle.`);
    await deliver(month, state, st, items, { incomplete: false });
    await writeState(month, await mergeFresh(month, state));
    return 'bundled';
  }

  // --- deadline (or explicit rebundle of an incomplete month): send what exists ---
  // justOpened exception: the first time we ever look at a month is the
  // request, not the deadline, even if the cron only started after the 20th.
  if (rebundle || (deadline && !justOpened)) {
    console.log(`${month}: ${rebundle ? 'rebundle' : 'deadline reached'} with ${items.length} item(s) missing, delivering incomplete bundle.`);
    if (!rebundle) {
      await say(`Oscar: ${monthNameEn(month)} deadline`, `It's the ${DEADLINE_DAY}th and ${monthNameEn(month)} is still incomplete (${items.length} item(s) missing). Bundling and emailing what exists, with the missing list on top.`);
    }
    await deliver(month, state, st, items, { incomplete: true });
    await writeState(month, await mergeFresh(month, state));
    return 'bundled-incomplete';
  }

  // --- still open: request / reminder ---
  const ids = items.map((i) => i.id);
  const changed = JSON.stringify(ids) !== JSON.stringify(state.lastMissing || null);
  const messagedToday = state.lastReminderOn === now.iso;
  const speak =
    trigger === 'manual' ||
    (trigger === 'due' && !messagedToday) ||
    (trigger === 'poll' && changed);

  let outcome = 'silent';
  if (speak) {
    outcome = state.lastMissing ? 'reminded' : 'requested';
    const { title, text } = buildMessage(month, items, state.lastMissing);
    await say(title, text);
    state.lastMissing = ids;
    state.lastReminderAt = new Date().toISOString();
    state.lastReminderOn = now.iso;
  } else {
    console.log(`${month}: still incomplete (${items.length} item(s)); ${trigger === 'poll' ? 'no change' : 'already messaged today'}, staying quiet.`);
  }
  await writeState(month, await mergeFresh(month, state));
  return outcome;
}

// status() saves the input fingerprint into close.json while it runs; keep it
// when we write our (older) in-memory copy back.
async function mergeFresh(month, state) {
  const fresh = await readState(month);
  return { ...state, lastFingerprint: fresh.lastFingerprint ?? state.lastFingerprint, registry: state.registry };
}

/**
 * Daily cron entry. Opens M-1 from the 14th, then checks every open month.
 */
export async function runDue() {
  const now = today();
  if (now.day >= CLOSE_DAY) {
    const prev = addMonths(`${now.year}-${String(now.month).padStart(2, '0')}`, -1);
    const s = await readState(prev);
    if (!s.status) console.log(`${prev}: opening for close.`);
  }
  const months = new Set((await monthsWithStatus('open')).map((x) => x.month));
  if (now.day >= CLOSE_DAY) {
    const prev = addMonths(`${now.year}-${String(now.month).padStart(2, '0')}`, -1);
    if (!(await readState(prev)).status) months.add(prev);
  }
  if (!months.size) { console.log(`Nothing to close today (${now.iso}).`); return; }

  for (const month of [...months].sort()) {
    // deadline = the 20th of the month AFTER the one being closed
    const deadline = now.iso >= `${addMonths(month, 1)}-${String(DEADLINE_DAY).padStart(2, '0')}`;
    try {
      await checkMonth(month, { trigger: 'due', deadline });
    } catch (err) {
      console.error(`${month}: close check failed: ${err.stack || err.message}`);
      await say(`Oscar: close check failed for ${month}`, err.message);
    }
  }
}

/**
 * Called by poll-inbox.js after a run that filed something (invoice, extract,
 * waiver). Bundles the moment the last missing piece lands; otherwise only
 * speaks if the list changed. Never throws into the poller.
 * @param {Iterable<string>} touchedMonths months that received files this run
 */
export async function afterFiling(touchedMonths = []) {
  try {
    // Decided BEFORE the re-check below, which may bundle a month in this very
    // run - that month is not a "late arrival".
    const touched = [...touchedMonths];
    const late = (await monthsWithStatus('bundled', 'bundled-incomplete')).map((x) => x.month).filter((m) => touched.includes(m));
    for (const { month } of await monthsWithStatus('open')) {
      try {
        await checkMonth(month, { trigger: 'poll' });
      } catch (err) {
        console.error(`${month}: close re-check failed: ${err.stack || err.message}`);
      }
    }
    // A late arrival in a month that already went out: flag it, never auto re-send.
    for (const month of late) {
      await say(`Oscar: late arrival for ${month}`, `Something was filed for ${month} after its bundle went out. Bundle not updated. To send a fresh one: node close-month.js --month=${month} --rebundle`);
    }
  } catch (err) {
    console.error(`close re-check failed: ${err.stack || err.message}`);
  }
}
