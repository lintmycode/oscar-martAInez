// U1: files bank-extract CSVs into the right month folder(s).
// Two entry points feed the same `fileExtract`:
//  - .csv attachments on intake emails (poll-inbox.js)
//  - the drop folder <data-root>/inbox/ (upload via the echo.ops share)
// Dropping straight into YYYY-MM/inputs/ keeps working and bypasses all this.
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { classifyExtract } from './extract-classifier.js';
import { ensureMonthScaffold } from './month-scaffold.js';
import { getDataRoot } from './paths.js';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Canonical, self-describing names (the originals are inconsistent and the
// same export lands in several month folders).
function canonicalName(c) {
  return c.type === 'ordem'
    ? `extrato-ordem_${c.from}_a_${c.to}.csv`
    : `extrato-cartao_${c.statement}.csv`;
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
 * Classify one CSV and copy it into every month folder it belongs in.
 * Same content already present in a target month (by sha256) is skipped, not
 * duplicated - re-sent exports and re-scanned drop files are common.
 * @returns {{result:'filed'|'duplicate'|'unrecognised', label?:string, filedMonths:string[]}}
 */
export async function fileExtract(buffer) {
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
    await fs.writeFile(path.join(inputsDir, uniqueIn(inputsDir, canonicalName(c))), buffer);
    filedMonths.push(month);
  }
  return {
    result: filedMonths.length ? 'filed' : 'duplicate',
    label: c.label,
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
    const r = await fileExtract(await cand.getBuffer());
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
 * Scan <data-root>/inbox/ once. Filed and duplicate files move to inbox/filed/,
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

  for (const name of names.filter((n) => n.toLowerCase().endsWith('.csv') && !n.startsWith('.'))) {
    const p = path.join(inbox, name);
    const st = await fs.stat(p);
    if (!st.isFile() || settleMs > 0 && Date.now() - st.mtimeMs < settleMs) continue;

    const r = await fileExtract(await fs.readFile(p));
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
