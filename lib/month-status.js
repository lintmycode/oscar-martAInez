// "What is still missing for month M?" - the one place that decides whether a
// month is complete. Used by the close job (close-month.js) and by poll-inbox.
//
// complete = extracts present and covering M
//            AND no company row without an invoice (after notes + waivers)
//            AND nothing in tmp/needs-review/ dated in M or undated.
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { classifyExtract } from './extract-classifier.js';
import { getDataRoot, resolvePaths } from './paths.js';
import { addMonths, lastDayOfMonth, parseMonth } from './months.js';
import { readState, writeState } from './close-state.js';

/** Which extracts are present, judged by content (see extract-classifier.js). */
export async function extractStatus(month) {
  const { inputsDir } = resolvePaths(month);
  const next = addMonths(month, 1);
  let ordemOk = false;
  const statements = new Set();
  let names = [];
  try { names = await fs.readdir(inputsDir); } catch { /* month folder not created yet */ }
  for (const n of names.filter((f) => f.toLowerCase().endsWith('.csv'))) {
    const c = classifyExtract(await fs.readFile(path.join(inputsDir, n)));
    if (!c) continue;
    if (c.type === 'ordem' && c.months.includes(month)) ordemOk = true;
    if (c.type === 'cartao') statements.add(c.statement);
  }
  const mm = (m) => `${m.slice(5)}-${m.slice(0, 4)}`;
  const { year, month: mon } = parseMonth(month);
  const dd = String(lastDayOfMonth(month)).padStart(2, '0');
  const pad = String(mon).padStart(2, '0');
  const missing = [];
  if (!ordemOk) missing.push({ id: 'ext:ordem', text: `CGD à ordem 01-${pad}-${year} to ${dd}-${pad}-${year}` });
  // For month M we need card statements M AND M+1: charges from late M post on
  // the next statement (every month since 2026-05 has used both).
  if (!statements.has(month)) missing.push({ id: `ext:cartao:${month}`, text: `card statement ${mm(month)}` });
  if (!statements.has(next)) missing.push({ id: `ext:cartao:${next}`, text: `card statement ${mm(next)}` });
  return {
    ordem: ordemOk,
    cartao: { [month]: statements.has(month), [next]: statements.has(next) },
    ok: missing.length === 0,
    missing,
  };
}

/**
 * Files in <data-root>/tmp/needs-review/ that block month M: they have no
 * month folder, so they count against M if their sidecar date is in M or
 * there is no date at all (listed until Nuno moves or deletes them).
 */
export async function needsReviewFor(month) {
  const dir = path.join(getDataRoot(), 'tmp', 'needs-review');
  let names = [];
  try { names = await fs.readdir(dir); } catch { return []; }
  const blocking = [];
  for (const n of names.filter((f) => !f.startsWith('.') && !f.toLowerCase().endsWith('.json'))) {
    let date = null;
    try {
      const side = JSON.parse(await fs.readFile(path.join(dir, `${path.basename(n, path.extname(n))}.json`), 'utf8'));
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(side.date || '').trim());
      if (m) date = `${m[3]}-${m[2]}`;
    } catch { /* no sidecar: undated */ }
    if (!date || date === month) blocking.push(n);
  }
  return blocking;
}

// Everything that can change what runMonth produces. When this is unchanged
// since the last run, the (cached-sidecar) re-run is skipped altogether.
async function fingerprint(month) {
  const { inputsDir, monthDir } = resolvePaths(month);
  const parts = [];
  const walk = async (dir) => {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else { const st = await fs.stat(p); parts.push(`${path.relative(inputsDir, p)}:${st.size}:${Math.round(st.mtimeMs)}`); }
    }
  };
  await walk(inputsDir);
  // waivers and the global rule files change the result without touching inputs/
  const extra = [path.join(monthDir, 'waivers.txt'), ...['transaction-notes.txt', 'exclusions.txt', 'invoice-exclusions.txt', 'personal-exceptions.txt', 'grouping-rules.txt', 'ignore-words.txt'].map((f) => path.join(process.cwd(), f))];
  for (const f of extra) {
    try { const st = await fs.stat(f); parts.push(`${path.basename(f)}:${st.size}:${Math.round(st.mtimeMs)}`); } catch { /* absent */ }
  }
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
}

/**
 * @param {string} month YYYY-MM
 * @param {{force?: boolean}} opts force = re-run even if inputs are unchanged
 * @returns {{month, extracts, missingInvoices, needsReview, complete, summary, ran}}
 */
export async function status(month, { force = false } = {}) {
  const extracts = await extractStatus(month);
  const needsReview = await needsReviewFor(month);
  const { outDir } = resolvePaths(month);
  const summaryPath = path.join(outDir, 'summary.json');

  let summary = null;
  let ran = false;
  if (extracts.ok) {
    const state = await readState(month);
    const fp = await fingerprint(month);
    try { summary = JSON.parse(await fs.readFile(summaryPath, 'utf8')); } catch { /* no run yet */ }
    // summary.json written before U2 has no missingInvoices: it can't be trusted.
    if (force || !summary || !Array.isArray(summary.missingInvoices) || state.lastFingerprint !== fp) {
      // Imported lazily: index.js pulls in the whole pipeline (exceljs, openai...).
      const { runMonth } = await import('../index.js');
      summary = await runMonth(month);
      ran = true;
      // Re-read state: runMonth takes a while and close.json may have changed.
      const fresh = await readState(month);
      fresh.lastFingerprint = fp;
      await writeState(month, fresh);
    }
  }

  const missingInvoices = extracts.ok ? summary.missingInvoices : [];
  return {
    month,
    extracts,
    missingInvoices,
    needsReview,
    complete: extracts.ok && missingInvoices.length === 0 && needsReview.length === 0,
    summary,
    ran,
  };
}
