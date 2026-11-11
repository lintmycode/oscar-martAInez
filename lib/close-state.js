// Per-month close state: <data-root>/YYYY-MM/close.json
//   { status: 'open'|'bundled'|'bundled-incomplete'|undefined,
//     openedAt, lastReminderAt, lastFingerprint, lastMissing: [ids], bundledAt, bundleSha,
//     registry: { next, byKey: {key: num}, byNum: {num: {date, description, amount}} } }
// `status` undefined = never opened (the file may still exist because
// month-status.js stores its input fingerprint there).
import fs from 'fs/promises';
import path from 'path';
import { getDataRoot, resolvePaths } from './paths.js';

const statePath = (month) => path.join(resolvePaths(month).monthDir, 'close.json');

export async function readState(month) {
  try {
    const s = JSON.parse(await fs.readFile(statePath(month), 'utf8'));
    s.registry ||= { next: 1, byKey: {}, byNum: {} };
    return s;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return { registry: { next: 1, byKey: {}, byNum: {} } };
  }
}

export async function writeState(month, state) {
  const file = statePath(month);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // write-then-rename so a reader (poll-inbox vs close-month) never sees a half file
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, file);
}

/** Months that have a close.json with the given status(es). */
export async function monthsWithStatus(...statuses) {
  const root = getDataRoot();
  const out = [];
  for (const name of (await fs.readdir(root)).filter((n) => /^\d{4}-\d{2}$/.test(n)).sort()) {
    const s = await readState(name);
    if (statuses.includes(s.status)) out.push({ month: name, state: s });
  }
  return out;
}

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
// Identity of a missing row. Two identical rows (same day/description/amount)
// share a key and so a number: waiving one waives both, which matches how
// waivers.txt matches them anyway.
export const missingKey = ({ date, description, amount }) =>
  `${date}|${squash(description)}|${Math.round(Math.abs(Number(amount)) * 100)}`;

/**
 * Give each missing row its number. Numbers are assigned the first time a row
 * is listed and never reused within the month (even after the row is
 * resolved), so "#3" in an old Telegram message can't silently point at a
 * different transaction later. Mutates state.registry; returns items with `num`.
 */
export function assignNumbers(state, missing) {
  const reg = state.registry;
  return missing.map((item) => {
    const key = missingKey(item);
    if (!reg.byKey[key]) {
      const num = reg.next++;
      reg.byKey[key] = num;
      reg.byNum[num] = { date: item.date, description: item.description, amount: item.amount };
    }
    return { ...item, num: reg.byKey[key] };
  });
}
