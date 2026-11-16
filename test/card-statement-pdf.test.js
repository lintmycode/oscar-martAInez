// CGD card statement PDF -> card CSV. The text fixture mimics `pdftotext -layout`
// output of a real statement (made-up merchants and amounts): page break inside
// a section, a wrapped description, the skipped "Conta Controlo" section.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCardStatementText, toCardCsv } from '../lib/card-statement-pdf.js';
import { classifyExtract } from '../lib/extract-classifier.js';
import { TransactionExtractor } from '../lib/transaction-extractor.js';

const pad = (s) => `               ${s}`;
const layout = ({ cardTotal = '61,30           5,00' } = {}) => [
  pad('C             Extrato Cartão'),
  pad('Cliente 100000000        Extrato 011/2026        Emissão 2026-11-05 Emissão do Extrato Anterior      2026-10-02     Pág 1/2'),
  '',
  pad('Movimentos Conta Controlo                                                   Moeda EUR'),
  pad('Dt. Ord. Pag.* Data Valor    Data Trans.   Refª   Descritivo do Movimento     Débitos      Créditos'),
  pad('2026-10-27      2026-10-03 2026-10-26     0     PAGAMENTO AUTOMATICO             0,00         99,00'),
  pad('Saldo Cred 0,00          Capital 97,00       Juros 0,00       Comissões 1,90     Impostos 0,10'),
  pad('2026-11-05      2026-11-06 2026-11-05     0     10100000000                     66,30'),
  pad('*Data de receção da ordem de pagamento.        Total de movimentos           66,30          99,00'),
  '',
  pad('Movimentos Conta Cartão 10100000000                                         Moeda EUR'),
  '',
  pad('caixadirecta - 217 900 790 (chamada para a rede fixa nacional), 24 horas por dia'),
  'CMZC777 -1866',
  pad('Cliente 100000000        Extrato 011/2026        Emissão 2026-11-05     Pág 2/2'),
  pad('Dt. Ord. Pag.* Data Valor    Data Trans. Refª   Descritivo do Movimento       Débitos      Créditos'),
  pad('2026-11-05      2026-11-05 2026-11-05     0     TRANSFERENCIA SALDO PARA CONTA      0,00         66,30'),
  '',
  pad('                                                CONTROLO'),
  pad('*Data de receção da ordem de pagamento.        Total de movimentos            0,00          66,30'),
  '',
  pad('Movimentos - CARTAO VISA CLASSIC EMPRESA                                    Moeda EUR'),
  pad('N.º do Cartão 4000********0000            Nome do Titular TEST HOLDER'),
  pad('Dt. Trans.      Refª     Descritivo do Movimento                            Débitos       Créditos'),
  pad('2026-10-22       0       SHOP ONE              shop.example/billLU             0,00          5,00'),
  pad('Mont. orig. 5,00                   Cód. Moeda EUR           Tx. Câmbio 1,000000        País LU'),
  pad('2026-10-25       0       SAAS SUB              SAAS.COMUS                     60,00          0,00'),
  pad('2026-10-25       0       2,0% COM SB                                           1,20          0,00'),
  pad('2026-10-25       0       IMPOSTO SELO S/COMISSOES (C)                          0,10          0,00'),
  pad(`                                                Total de movimentos           ${cardTotal}`),
  pad('Fim de Extrato'),
].join('\n');

test('parses statement number, skips Conta Controlo, joins wrapped descriptions', () => {
  const p = parseCardStatementText(layout());
  assert.equal(p.statement, '2026-11');
  assert.equal(p.issued, '2026-11-05');
  assert.equal(p.rows.length, 5);
  assert.equal(p.rows[0].description, 'TRANSFERENCIA SALDO PARA CONTA CONTROLO');
  assert.equal(p.rows[0].credit, '66,30');
  assert.deepEqual(p.rows.map((r) => r.date), ['2026-11-05', '2026-10-22', '2026-10-25', '2026-10-25', '2026-10-25']);
  assert.ok(!p.rows.some((r) => /PAGAMENTO AUTOMATICO/.test(r.description)));
});

test('rows that do not add up to the PDF total throw instead of filing a wrong extract', () => {
  assert.throws(() => parseCardStatementText(layout({ cardTotal: '61,40           5,00' })), /layout changed/);
});

test('not a card statement -> null', () => {
  assert.equal(parseCardStatementText('Fatura FT 2026/123\nTotal 12,30 EUR'), null);
});

test('converted CSV classifies and extracts like a CGD card export', async () => {
  const csv = toCardCsv(parseCardStatementText(layout()), 'x.pdf');
  const c = classifyExtract(csv);
  assert.equal(c.type, 'cartao');
  assert.deepEqual(c.months, ['2026-10', '2026-11']);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oscar-cardpdf-'));
  try {
    await fs.writeFile(path.join(dir, 's.csv'), csv);
    const quiet = console.log; console.log = () => {};
    let oct;
    try { oct = await TransactionExtractor.extractFromFile(path.join(dir, 's.csv'), { year: 2026, month: 10 }); } finally { console.log = quiet; }
    assert.deepEqual(oct.map((t) => [t.date, t.amount]), [['22/10/2026', -5], ['25/10/2026', 60], ['25/10/2026', 1.2], ['25/10/2026', 0.1]]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// Real PDFs (bank data, never committed): OSCAR_TEST_CARD_PDF_DIR=<folder with statement PDFs>.
test('real statement PDFs convert and file into both months, PDF alongside', async (t) => {
  const src = process.env.OSCAR_TEST_CARD_PDF_DIR;
  if (!src) return t.skip('set OSCAR_TEST_CARD_PDF_DIR to a folder of CGD card statement PDFs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oscar-cardpdf-'));
  const keep = process.env.OSCAR_DATA_ROOT;
  process.env.OSCAR_DATA_ROOT = root;
  try {
    const { fileExtract, convertCardPdfsIn } = await import('../lib/csv-intake.js');
    const pdfs = (await fs.readdir(src)).filter((n) => n.endsWith('.pdf'));
    assert.ok(pdfs.length, 'no PDFs in OSCAR_TEST_CARD_PDF_DIR');
    const first = await fs.readFile(path.join(src, pdfs[0]));
    const r = await fileExtract(first, { sourceName: pdfs[0] });
    assert.equal(r.result, 'filed');
    assert.equal(r.filedMonths.length, 2);
    for (const m of r.filedMonths) {
      const names = await fs.readdir(path.join(root, m, 'inputs'));
      assert.ok(names.some((n) => n.endsWith('.csv')) && names.some((n) => n.endsWith('.pdf')), `${m}: ${names}`);
    }
    // same PDF again: duplicate, nothing new
    assert.equal((await fileExtract(first, { sourceName: pdfs[0] })).result, 'duplicate');

    // dropped straight into inputs/ of a month that already has that statement -> left alone
    const m = r.filedMonths[0];
    await fs.copyFile(path.join(src, pdfs[0]), path.join(root, m, 'inputs', 'dropped.pdf'));
    assert.deepEqual(await convertCardPdfsIn(m), []);
  } finally {
    if (keep === undefined) delete process.env.OSCAR_DATA_ROOT; else process.env.OSCAR_DATA_ROOT = keep;
    await fs.rm(root, { recursive: true, force: true });
  }
});
