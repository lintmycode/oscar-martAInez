// U1: files bank-extract CSVs into the right month folder(s).
// Two entry points feed the same `fileExtract`:
//  - .csv attachments on intake emails (poll-inbox.js)
//  - the drop folder <data-root>/inbox/ (upload via the echo.ops share)
// Dropping straight into YYYY-MM/inputs/ keeps working and bypasses all this.
//
// Card statements as PDF (the CGD app stopped exporting CSV in 11/2026) go
// through the same paths: converted to the old card CSV layout by
// card-statement-pdf.js, filed as CSV + the original PDF beside it. PDFs that
// land straight in YYYY-MM/inputs/ are converted by convertCardPdfsIn().
// A PDF is only converted when no CSV export of that statement is there yet,
// so sending both never double-counts a statement.
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { classifyExtract } from './extract-classifier.js';
import { cardPdfToCsv, pdfLayoutText, looksLikeCardStatement } from './card-statement-pdf.js';
import { ensureMonthScaffold } from './month-scaffold.js';
import { getDataRoot, resolvePaths } from './paths.js';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Canonical, self-describing names (the originals are inconsistent and the
// same export lands in several month folders).
function canonicalName(c) {
  return c.type === 'ordem'
    ? `extrato-ordem_${c.from}_a_${c.to}.csv`
    : `extrato-cartao_${c.statement}.csv`;
}

const isPdf = (buf) => buf.subarray(0, 5).toString('latin1') === '%PDF-';

/** Cheap pre-check used by the email path to keep statement PDFs out of invoice intake. */
export const isCardStatementPdf = (buf) => isPdf(buf) && looksLikeCardStatement(pdfLayoutText(buf));

/** Is there already a card CSV (export or converted) for this statement in dir? */
async function hasCardStatement(dir, statement) {
  let names = [];
  try { names = await fs.readdir(dir); } catch { return false; }
  for (const n of names.filter((f) => f.toLowerCase().endsWith('.csv'))) {
    const c = classifyExtract(await fs.readFile(path.join(dir, n)));
    if (c?.type === 'cartao' && c.statement === statement) return true;
  }
  return false;
}

async function hashesInDir(dir) {
  const hashes = new Set();
  let names = [];
  try { names = await fs.readdir(dir); } catch { return hashes; }
  for (const n of names.filter((f) => f.toLowerCase().endsWith('.csv'))) {
    hashes.add(sha256(await fs.readFile(path.join(dir, n))));
  }
  return hashes;
}

function uniqueIn(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = name;
  for (let n = 1; existsSync(path.join(dir, candidate)); n++) candidate = `${base}-${n}${ext}`;
  return candidate;
}

/**
 * Classify one CSV (or card-statement PDF) and copy it into every month folder
 * it belongs in. Same content already present in a target month (by sha256) is
 * skipped, not duplicated - re-sent exports and re-scanned drop files are common.
 * @param {Buffer} input CSV or PDF bytes
 * @param {{sourceName?:string}} [o] original filename, recorded in converted CSVs
 * @returns {{result:'filed'|'duplicate'|'unrecognised', label?:string, filedMonths:string[]}}
 */
export async function fileExtract(input, { sourceName = '' } = {}) {
  let buffer = input;
  let pdf = null;
  if (isPdf(input)) {
    let conv;
    try {
      conv = cardPdfToCsv(input, sourceName);
    } catch (err) {
      // A card statement whose rows don't add up: report it, never file a wrong extract.
      console.error(`  card statement PDF "${sourceName}": ${err.message}`);
      return { result: 'unrecognised', label: err.message, filedMonths: [] };
    }
    if (!conv) return { result: 'unrecognised', filedMonths: [] };
    buffer = conv.csv;
    pdf = input;
  }
  const c = classifyExtract(buffer);
  if (!c || c.months.length === 0) {
    // months.length === 0: an ordem export that doesn't fully cover any month
    // (e.g. "01-10 a 10-10"), so it can't complete anything - say so rather
    // than silently filing a useless file.
    return { result: 'unrecognised', label: c ? `${c.label} (covers no full month)` : undefined, filedMonths: [] };
  }
  const hash = sha256(buffer);
  const filedMonths = [];
  for (const month of c.months) {
    const { inputsDir } = await ensureMonthScaffold(month);
    if ((await hashesInDir(inputsDir)).has(hash)) continue;
    // PDF: a CSV of the same statement already there (export or earlier PDF) wins.
    if (pdf && await hasCardStatement(inputsDir, c.statement)) continue;
    const csvName = uniqueIn(inputsDir, canonicalName(c));
    await fs.writeFile(path.join(inputsDir, csvName), buffer);
    // Keep the official PDF next to its CSV: it goes into the accountant's bundle.
    if (pdf) await fs.writeFile(path.join(inputsDir, uniqueIn(inputsDir, csvName.replace(/\.csv$/, '.pdf'))), pdf);
    filedMonths.push(month);
  }
  return {
    result: filedMonths.length ? 'filed' : 'duplicate',
    label: pdf ? `${c.label} (PDF)` : c.label,
    classification: c,
    filedMonths,
  };
}

export const describeFiled = (r) => `${r.label} → ${r.filedMonths.join(', ')}`;

/** .csv attachment parts of a Gmail payload (does not descend into message/rfc822). */
export function collectCsvParts(payload, acc = []) {
  if (!payload || payload.mimeType === 'message/rfc822') return acc;
  if (payload.filename && /\.csv$/i.test(payload.filename) && payload.body && (payload.body.attachmentId || payload.body.data)) {
    acc.push(payload);
  }
  for (const part of payload.parts || []) collectCsvParts(part, acc);
  return acc;
}

/**
 * File every CSV candidate of one email.
 * @param candidates [{filename, getBuffer}]
 * @returns {{filed:string[], duplicates:number, unrecognised:string[], months:string[]}}
 */
export async function intakeCsvCandidates(candidates) {
  const out = { filed: [], duplicates: 0, unrecognised: [], months: [] };
  for (const cand of candidates) {
    const r = await fileExtract(await cand.getBuffer(), { sourceName: cand.filename });
    if (r.result === 'filed') {
      out.filed.push(describeFiled(r));
      out.months.push(...r.filedMonths);
    } else if (r.result === 'duplicate') {
      out.duplicates += 1;
    } else {
      out.unrecognised.push(cand.filename);
    }
  }
  return out;
}

/**
 * Scan <data-root>/inbox/ once (CSVs and card-statement PDFs). Filed and duplicate files move to inbox/filed/,
 * unrecognised ones to inbox/unrecognised/ (moved, not left, so each is
 * reported exactly once instead of every 10-minute run).
 * Files touched in the last `settleMs` are skipped: an SMB copy in progress
 * would otherwise be read half-written.
 */
export async function scanDropFolder({ dataRoot = getDataRoot(), settleMs = 30000 } = {}) {
  const inbox = path.join(dataRoot, 'inbox');
  const out = { filed: [], unrecognised: [], months: [] };
  let names;
  try { names = await fs.readdir(inbox); } catch { return out; }

  for (const name of names.filter((n) => /\.(csv|pdf)$/i.test(n) && !n.startsWith('.'))) {
    const p = path.join(inbox, name);
    const st = await fs.stat(p);
    if (!st.isFile() || settleMs > 0 && Date.now() - st.mtimeMs < settleMs) continue;

    const r = await fileExtract(await fs.readFile(p), { sourceName: name });
    const destDir = path.join(inbox, r.result === 'unrecognised' ? 'unrecognised' : 'filed');
    await fs.mkdir(destDir, { recursive: true });
    await fs.rename(p, path.join(destDir, uniqueIn(destDir, name)));

    if (r.result === 'filed') {
      out.filed.push(describeFiled(r));
      out.months.push(...r.filedMonths);
    } else if (r.result === 'unrecognised') {
      out.unrecognised.push(name);
    }
  }
  return out;
}

/**
 * Card-statement PDFs saved straight into YYYY-MM/inputs/ (by hand, or by Beth
 * from Telegram): write the converted CSV beside each one (same name, .csv),
 * then file it into the statement's other month too (statement S covers S-1
 * and S). Skipped when the CSV is already there or a CSV export of the same
 * statement exists. Non-statement PDFs are left alone. Never throws.
 * @returns {Promise<string[]>} labels of what was converted, for logging
 */
export async function convertCardPdfsIn(month) {
  const { inputsDir } = resolvePaths(month);
  const done = [];
  let entries = [];
  try { entries = await fs.readdir(inputsDir, { withFileTypes: true }); } catch { return done; }
  for (const e of entries.filter((x) => x.isFile() && /\.pdf$/i.test(x.name))) {
    const csvPath = path.join(inputsDir, e.name.replace(/\.pdf$/i, '.csv'));
    if (existsSync(csvPath)) continue;
    try {
      const buf = await fs.readFile(path.join(inputsDir, e.name));
      const conv = cardPdfToCsv(buf, e.name);
      if (!conv || await hasCardStatement(inputsDir, conv.statement)) continue;
      await fs.writeFile(csvPath, conv.csv);
      // Same bytes as csvPath, so this month is skipped by hash; the other one gets CSV + PDF.
      await fileExtract(buf, { sourceName: e.name });
      done.push(`${e.name} → card statement ${conv.statement}, ${conv.rowCount} rows`);
    } catch (err) {
      console.error(`  ${month}/inputs/${e.name}: ${err.message}`);
    }
  }
  if (done.length) console.log(`${month}: converted card statement PDF(s): ${done.join('; ')}`);
  return done;
}
