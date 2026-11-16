// CGD card statements as PDF -> the CSV format the rest of Oscar already reads.
//
// Since 11/2026 the CGD app only gives the monthly card statement ("Extrato
// Cartão") as a PDF, no CSV. Rather than teach the pipeline a second format,
// a PDF statement is converted into the same shape as the old card CSV export
// (header "Consultar saldos e movimentos de cartões", "Extrato ;MM-YYYY",
// rows "Data ;Data valor ;Descrição ;Débito ;Crédito ;"), so the classifier,
// transaction extractor and bundle treat it exactly like a downloaded CSV.
// CSV exports keep working unchanged; conversion only happens for PDFs.
//
// Verified against statement 10/2026, which exists in both formats: the
// converted rows match the CSV export row for row (dates, amounts, debit/credit).
//
// Layout read with `pdftotext -layout` (poppler, installed on echo and the laptop):
//   "Extrato 011/2026   Emissão 2026-11-05"          statement number + issue date
//   "Movimentos Conta Controlo"                      payments from the bank account: SKIPPED
//                                                    (the old CSV export never had them)
//   "Movimentos Conta Cartão 10104547020"            rows: DtOrdPag DataValor DataTrans Ref Desc Deb Cred
//   "Movimentos - CARTAO VISA CLASSIC EMPRESA"       rows: DataTrans Ref Desc Deb Cred
//   "Total de movimentos  <deb>  <cred>"             ends a section; used to verify the parse
// Sections run across page breaks (page footer + header repeat in between).
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const AMOUNT = String.raw`\d{1,3}(?:\.\d{3})*,\d{2}`;
const DATE = String.raw`\d{4}-\d{2}-\d{2}`;
// Conta Cartão: Dt.Ord.Pag  DataValor  DataTrans  Ref  Description  Débitos  Créditos
const CONTA_ROW = new RegExp(String.raw`^\s*(${DATE})\s+(${DATE})\s+(${DATE})\s+(\d+)\s+(.+?)\s+(${AMOUNT})\s+(${AMOUNT})\s*$`);
// Card: DataTrans  Ref  Description  Débitos  Créditos
const CARD_ROW = new RegExp(String.raw`^\s*(${DATE})\s+(\d+)\s+(.+?)\s+(${AMOUNT})\s+(${AMOUNT})\s*$`);
const TOTAL = new RegExp(String.raw`Total de movimentos\s+(${AMOUNT})\s+(${AMOUNT})`);
// Lines that can sit between a row and the next one but are never part of a description.
const NOT_CONTINUATION = /^(Mont\. orig|Saldo Cred|\*Data|Total|caixadirecta|Em caso|Caixa Geral|Cliente|Dt\.|N\.º|Movimentos|Para esclarecimentos|Fim de Extrato|C$|C?MZC)/;

const cents = (s) => Math.round(Number(s.replace(/\./g, '').replace(',', '.')) * 100);
const ymdToDmy = (s) => s.split('-').reverse().join('-');
const squash = (s) => s.replace(/\s+/g, ' ').trim();

/** Text of a PDF via pdftotext -layout. Returns '' if it can't be read. */
export function pdfLayoutText(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-card-'));
  const file = path.join(dir, 'statement.pdf');
  try {
    fs.writeFileSync(file, buffer);
    return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  } catch {
    return '';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Cheap check before the full parse: is this text a CGD card statement? */
export const looksLikeCardStatement = (text) => /Extrato Cart[aã]o/.test(text) && /Extrato\s+\d{3}\/\d{4}/.test(text);

/**
 * Parse the pdftotext -layout text of a CGD card statement.
 * @returns {null | {statement:string, issued:string, rows:Array<{date,valueDate,description,debit,credit}>}}
 *   statement 'YYYY-MM'; issued 'YYYY-MM-DD'; debit/credit as the original "1.234,56" strings.
 * @throws if it IS a card statement but the rows don't add up to the statement's
 *   own "Total de movimentos" (a layout change we'd otherwise silently mis-read).
 */
export function parseCardStatementText(text) {
  if (!looksLikeCardStatement(text)) return null;
  const st = /Extrato\s+(\d{3})\/(\d{4})/.exec(text);
  const iss = new RegExp(String.raw`Emiss[aã]o\s+(${DATE})`).exec(text);
  const month = Number(st[1]);
  if (month < 1 || month > 12 || !iss) return null;
  const statement = `${st[2]}-${String(month).padStart(2, '0')}`;

  const rows = [];
  let section = null;       // 'skip' | 'conta' | 'card' | null
  let sectionRows = [];
  let last = null;          // the row a continuation line may extend
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^Movimentos Conta Controlo/.test(line)) { section = 'skip'; sectionRows = []; last = null; continue; }
    if (/^Movimentos Conta Cart[aã]o/.test(line)) { section = 'conta'; sectionRows = []; last = null; continue; }
    if (/^Movimentos\s+-\s+CART/.test(line)) { section = 'card'; sectionRows = []; last = null; continue; }
    if (!section) continue;

    const total = TOTAL.exec(line);
    if (total) {
      if (section !== 'skip') {
        const deb = sectionRows.reduce((s, r) => s + cents(r.debit), 0);
        const cred = sectionRows.reduce((s, r) => s + cents(r.credit), 0);
        if (deb !== cents(total[1]) || cred !== cents(total[2])) {
          throw new Error(`card statement ${statement}: rows add up to ${deb / 100}/${cred / 100} but the PDF says ${total[1]}/${total[2]} - layout changed?`);
        }
        rows.push(...sectionRows);
      }
      section = null; sectionRows = []; last = null;
      continue;
    }
    if (section === 'skip') continue;

    let m;
    if (section === 'conta' && (m = CONTA_ROW.exec(raw))) {
      last = { date: m[1], valueDate: m[2], description: squash(m[5]), debit: m[6], credit: m[7] };
      sectionRows.push(last);
    } else if (section === 'card' && (m = CARD_ROW.exec(raw))) {
      // The PDF only has the transaction date; the CSV export's "Data valor"
      // (the column the extractor uses) is that same date.
      last = { date: m[1], valueDate: m[1], description: squash(m[3]), debit: m[4], credit: m[5] };
      sectionRows.push(last);
    } else if (last && !NOT_CONTINUATION.test(line) && !new RegExp(AMOUNT).test(line)) {
      // Long descriptions wrap onto the next line ("TRANSFERENCIA SALDO PARA CONTA" / "CONTROLO").
      last.description = `${last.description} ${squash(line)}`;
      last = null;
    } else {
      last = null;
    }
  }
  return { statement, issued: iss[1], rows };
}

/**
 * Render parsed rows in the old CGD card CSV layout (UTF-8 with BOM; the
 * classifier and csv-parser both read that).
 */
export function toCardCsv({ statement, issued, rows }, sourceName = '') {
  const [y, m] = statement.split('-');
  const cell = (s) => String(s).replace(/;/g, ',');
  const lines = [
    `Consultar saldos e movimentos de cartões - ${ymdToDmy(issued)}`,
    `Origem ;convertido de PDF${sourceName ? ` (${cell(sourceName)})` : ''} pelo Oscar`,
    '',
    `Extrato ;${m}-${y}`,
    '',
    'Data ;Data valor ;Descrição ;Débito ;Crédito ;',
    ...rows.map((r) => [
      ymdToDmy(r.date), ymdToDmy(r.valueDate), cell(r.description),
      cents(r.debit) ? r.debit : '', cents(r.credit) ? r.credit : '',
    ].join(' ;') + ' ;'),
  ];
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')]);
}

/**
 * PDF buffer -> {statement, csv: Buffer} or null when it isn't a CGD card statement.
 * Throws when it is one but can't be parsed reliably (see parseCardStatementText).
 */
export function cardPdfToCsv(buffer, sourceName = '') {
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return null;
  const parsed = parseCardStatementText(pdfLayoutText(buffer));
  if (!parsed) return null;
  return { statement: parsed.statement, rowCount: parsed.rows.length, csv: toCardCsv(parsed, sourceName) };
}
