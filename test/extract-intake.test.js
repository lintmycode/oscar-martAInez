// U1: extract classification + filing. Fixtures reproduce the real CGD header
// formats (card = latin1 + CRLF, current account = UTF-8 with BOM + LF).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyExtract } from '../lib/extract-classifier.js';
import { cardCsv, ordemCsv } from './fixtures.js';

test('card statement MM-YYYY belongs to M-1 and M', () => {
  const c = classifyExtract(cardCsv('11-2026'));
  assert.equal(c.type, 'cartao');
  assert.equal(c.statement, '2026-11');
  assert.deepEqual(c.months, ['2026-10', '2026-11']);
});

test('card statement in January rolls the year back', () => {
  assert.deepEqual(classifyExtract(cardCsv('01-2027')).months, ['2026-12', '2027-01']);
});

test('ordem interval fills every fully covered month', () => {
  const c = classifyExtract(ordemCsv('01-07-2026', '30-09-2026'));
  assert.equal(c.type, 'ordem');
  assert.deepEqual(c.months, ['2026-07', '2026-08', '2026-09']);
});

test('ordem interval ending mid-month does not cover that month', () => {
  assert.deepEqual(classifyExtract(ordemCsv('01-08-2026', '10-10-2026')).months, ['2026-08', '2026-09']);
  assert.deepEqual(classifyExtract(ordemCsv('01-10-2026', '10-10-2026')).months, []);
});

test('leap-year February is covered by 29', () => {
  assert.deepEqual(classifyExtract(ordemCsv('01-02-2028', '29-02-2028')).months, ['2028-02']);
});

test('unrecognised content returns null', () => {
  assert.equal(classifyExtract(Buffer.from('Data;Valor\n01-01-2026;1,00\n')), null);
  assert.equal(classifyExtract(Buffer.from('')), null);
  assert.equal(classifyExtract(Buffer.from('Consultar saldos e movimentos de cartões - x\r\nsem extrato\r\n', 'latin1')), null);
});

test('real example files from the data share classify (when present)', async (t) => {
  const dir = process.env.OSCAR_TEST_REAL_DIR;
  if (!dir) return t.skip('set OSCAR_TEST_REAL_DIR to a month inputs/ folder');
  const out = {};
  for (const f of (await fs.readdir(dir)).filter((n) => n.endsWith('.csv'))) {
    out[f] = classifyExtract(await fs.readFile(path.join(dir, f)));
    assert.ok(out[f], `${f} should classify`);
  }
});

// --- filing ---------------------------------------------------------------
async function withRoot(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oscar-u1-'));
  const prev = process.env.OSCAR_DATA_ROOT;
  process.env.OSCAR_DATA_ROOT = root;
  try { await fn(root); } finally {
    if (prev === undefined) delete process.env.OSCAR_DATA_ROOT; else process.env.OSCAR_DATA_ROOT = prev;
    await fs.rm(root, { recursive: true, force: true });
  }
}
const csvsIn = async (root, m) => (await fs.readdir(path.join(root, m, 'inputs'))).filter((n) => n.endsWith('.csv'));

test('fileExtract copies a card statement into two months and dedupes by content', async () => {
  const { fileExtract } = await import('../lib/csv-intake.js');
  await withRoot(async (root) => {
    const r1 = await fileExtract(cardCsv('11-2026'));
    assert.equal(r1.result, 'filed');
    assert.deepEqual(r1.filedMonths, ['2026-10', '2026-11']);
    assert.deepEqual(await csvsIn(root, '2026-10'), ['extrato-cartao_2026-11.csv']);
    // Same bytes again (different "filename" is irrelevant): skipped.
    const r2 = await fileExtract(cardCsv('11-2026'));
    assert.equal(r2.result, 'duplicate');
    assert.deepEqual(await csvsIn(root, '2026-11'), ['extrato-cartao_2026-11.csv']);
    // Same statement month but different content (re-export) is kept alongside.
    const changed = Buffer.concat([cardCsv('11-2026'), Buffer.from('04-10-2026 ;04-10-2026 ;X ;1,00 ;;\r\n')]);
    const r3 = await fileExtract(changed);
    assert.equal(r3.result, 'filed');
    assert.equal((await csvsIn(root, '2026-10')).length, 2);
  });
});

test('fileExtract reports unrecognised files without writing anything', async () => {
  const { fileExtract } = await import('../lib/csv-intake.js');
  await withRoot(async (root) => {
    const r = await fileExtract(Buffer.from('a;b\n1;2\n'));
    assert.equal(r.result, 'unrecognised');
    assert.deepEqual(await fs.readdir(root), []);
  });
});

test('drop folder: files recognised CSVs, moves them, quarantines unknown ones', async () => {
  const { scanDropFolder } = await import('../lib/csv-intake.js');
  await withRoot(async (root) => {
    const inbox = path.join(root, 'inbox');
    await fs.mkdir(inbox);
    await fs.writeFile(path.join(inbox, 'whatever-name.csv'), ordemCsv('01-07-2026', '30-09-2026'));
    await fs.writeFile(path.join(inbox, 'junk.csv'), 'hello;world\n');
    const r = await scanDropFolder({ dataRoot: root, settleMs: 0 });
    assert.deepEqual(r.months.sort(), ['2026-07', '2026-08', '2026-09']);
    assert.deepEqual(r.unrecognised, ['junk.csv']);
    assert.deepEqual(await fs.readdir(path.join(inbox, 'filed')), ['whatever-name.csv']);
    assert.deepEqual(await fs.readdir(path.join(inbox, 'unrecognised')), ['junk.csv']);
    // second scan: nothing left to do, nothing re-reported
    const again = await scanDropFolder({ dataRoot: root, settleMs: 0 });
    assert.deepEqual(again, { filed: [], unrecognised: [], months: [] });
  });
});

test('drop folder skips files still being written', async () => {
  const { scanDropFolder } = await import('../lib/csv-intake.js');
  await withRoot(async (root) => {
    await fs.mkdir(path.join(root, 'inbox'));
    await fs.writeFile(path.join(root, 'inbox', 'fresh.csv'), cardCsv('10-2026'));
    const r = await scanDropFolder({ dataRoot: root, settleMs: 60000 });
    assert.deepEqual(r.filed, []);
    assert.deepEqual(await fs.readdir(path.join(root, 'inbox')), ['fresh.csv']);
  });
});

test('email: CSV attachments are found in a Gmail-shaped payload and filed', async () => {
  const { collectCsvParts, intakeCsvCandidates } = await import('../lib/csv-intake.js');
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'text/plain', filename: '', body: { data: 'aGk' } },
      { mimeType: 'text/csv', filename: 'Movimentos.CSV', body: { attachmentId: 'a1' } },
      { mimeType: 'application/pdf', filename: 'x.pdf', body: { attachmentId: 'a2' } },
      { mimeType: 'text/csv', filename: 'lixo.csv', body: { attachmentId: 'a3' } },
      // an embedded forwarded email is handled as its own source, not descended into
      { mimeType: 'message/rfc822', filename: 'fwd.eml', body: {}, parts: [{ mimeType: 'text/csv', filename: 'inner.csv', body: { attachmentId: 'a4' } }] },
    ],
  };
  const parts = collectCsvParts(payload);
  assert.deepEqual(parts.map((p) => p.filename), ['Movimentos.CSV', 'lixo.csv']);
  const buffers = { a1: cardCsv('10-2026'), a3: Buffer.from('not;an;extract\n') };
  await withRoot(async (root) => {
    const r = await intakeCsvCandidates(parts.map((p) => ({ filename: p.filename, getBuffer: async () => buffers[p.body.attachmentId] })));
    assert.deepEqual(r.filed, ['extrato cartão 10-2026 → 2026-09, 2026-10']);
    assert.deepEqual(r.unrecognised, ['lixo.csv']);
    assert.deepEqual(await csvsIn(root, '2026-09'), ['extrato-cartao_2026-10.csv']);
  });
});
