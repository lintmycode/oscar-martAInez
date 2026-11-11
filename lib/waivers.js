// Per-month "no invoice expected" waivers: <data-root>/YYYY-MM/waivers.txt.
// Same idea as transaction-notes.txt (a note on a row that will never have an
// invoice) but scoped to ONE month and to one specific transaction, so a
// one-off (refund, returned transfer) doesn't need a global pattern rule.
//
// Line format (hand-editable on the share; # starts a comment):
//   DD/MM/YYYY | DESCRIPTION | AMOUNT → reason
// DESCRIPTION is matched like transaction-notes.txt patterns (case-insensitive,
// * wildcard, whitespace collapsed); AMOUNT compares to the cent ("45.00" or "45,00").
import fs from 'fs/promises';
import path from 'path';
import { resolvePaths } from './paths.js';

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const cents = (n) => Math.round(Math.abs(Number(String(n).replace(',', '.'))) * 100);

export const waiversPath = (month) => path.join(resolvePaths(month).monthDir, 'waivers.txt');

function patternToRegex(pattern) {
  const escaped = squash(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function parseWaiverLine(line) {
  const m = /^\s*(\d{2}\/\d{2}\/\d{4})\s*\|\s*(.*?)\s*\|\s*(-?[\d.,]+)\s*(?:→|->)\s*(.*?)\s*$/.exec(line);
  if (!m) return null;
  return { date: m[1], description: m[2], amount: m[3], reason: m[4], pattern: patternToRegex(m[2]) };
}

export async function loadWaivers(month) {
  let text;
  try { text = await fs.readFile(waiversPath(month), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const waivers = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const w = parseWaiverLine(t);
    if (w) waivers.push(w);
    else console.warn(`Warning: ignoring malformed waiver line in ${month}/waivers.txt: ${t}`);
  }
  return waivers;
}

/** @returns the waiver covering this row, or undefined */
export function findWaiver(waivers, { date, description, amount }) {
  return waivers.find((w) => w.date === date && cents(w.amount) === cents(amount) && w.pattern.test(squash(description)));
}

/** Append waivers (deduped) to the month's waivers.txt. @returns number actually added */
export async function appendWaivers(month, entries) {
  const existing = await loadWaivers(month);
  const lines = [];
  for (const e of entries) {
    if (findWaiver(existing, e)) continue;
    const reason = squash(e.reason) || 'No invoice expected (waived by email)';
    lines.push(`${e.date} | ${squash(e.description)} | ${Math.abs(Number(e.amount)).toFixed(2)} → ${reason}`);
  }
  if (lines.length) {
    const file = waiversPath(month);
    let prefix = '';
    try {
      const cur = await fs.readFile(file, 'utf8');
      if (cur && !cur.endsWith('\n')) prefix = '\n';
    } catch { prefix = '# Waivers: DD/MM/YYYY | DESCRIPTION | AMOUNT → reason (see README "Monthly close")\n'; }
    await fs.appendFile(file, prefix + lines.join('\n') + '\n');
  }
  return lines.length;
}
