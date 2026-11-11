// Classifies a CGD bank-extract CSV by its CONTENT (header lines), never by
// filename: the names Nuno saves them under aren't consistent (`cc-mai` but
// `ordem-may`), and a file arriving by email keeps whatever name the sender
// gave it.
//
// Real header shapes (CGD, `;`-separated, latin1 or UTF-8 with BOM):
//   Card:    "Consultar saldos e movimentos de cartões - 10-10-2026"
//            ...
//            "Extrato ;10-2026"                 <- the statement month
//   Current: "Consultar saldos e movimentos à ordem - 10-10-2026;="0206013058630""
//            ...
//            "Intervalo de;01-07-2026 a 30-09-2026"   <- period covered
import { fmtMonth, parseMonth, addMonths, lastDayOfMonth } from './months.js';

// Same idea as csv-parser.js (jschardet + fallbacks) but deterministic for
// these two known formats: a BOM or a clean strict-UTF-8 decode means UTF-8,
// anything else is latin1 (the CGD card export).
export function decodeText(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('iso-8859-1').decode(buffer);
  }
}

// Lowercase + strip accents so "à"/"a" and "cartões"/"cartoes" compare equal.
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * @returns {null | {type:'ordem', from:string, to:string, months:string[], label:string}
 *                | {type:'cartao', statement:string, months:string[], label:string}}
 * `months` = the month folders this file belongs in:
 *  - ordem: every month the interval FULLY covers (a 3-month export fills 3 months);
 *  - cartao: statement S covers S-1 and S. Card charges from late M post on the
 *    next statement (M+1), so a month needs both its own statement and the next
 *    one; each statement is therefore filed into two months.
 */
export function classifyExtract(buffer) {
  const lines = decodeText(buffer).split(/\r?\n/).slice(0, 30);
  const head = fold(lines[0] || '');
  if (!head.includes('consultar saldos e movimentos')) return null;

  if (/\bordem\b/.test(head)) {
    for (const line of lines) {
      const m = /^\s*intervalo de\s*;\s*(\d{2})-(\d{2})-(\d{4})\s+a\s+(\d{2})-(\d{2})-(\d{4})/i.exec(line);
      if (!m) continue;
      const from = `${m[3]}-${m[2]}-${m[1]}`;
      const to = `${m[6]}-${m[5]}-${m[4]}`;
      const months = [];
      // A month counts as covered only if both its first and last day are inside.
      let cur = fmtMonth(Number(m[3]), Number(m[2]));
      const end = fmtMonth(Number(m[6]), Number(m[5]));
      for (let guard = 0; guard < 60 && cur <= end; guard++, cur = addMonths(cur, 1)) {
        const first = `${cur}-01`;
        const last = `${cur}-${String(lastDayOfMonth(cur)).padStart(2, '0')}`;
        if (from <= first && to >= last) months.push(cur);
      }
      return { type: 'ordem', from, to, months, label: `extrato à ordem ${m[1]}-${m[2]}-${m[3]} a ${m[4]}-${m[5]}-${m[6]}` };
    }
    return null; // header recognised but no period line: let a human look
  }

  if (/cartoes|cartao/.test(head)) {
    for (const line of lines) {
      const m = /^\s*extrato\s*;\s*(\d{2})-(\d{4})/i.exec(line);
      if (!m) continue;
      const statement = `${m[2]}-${m[1]}`;
      try { parseMonth(statement); } catch { return null; }
      return { type: 'cartao', statement, months: [addMonths(statement, -1), statement], label: `extrato cartão ${m[1]}-${m[2]}` };
    }
    return null;
  }
  return null;
}
