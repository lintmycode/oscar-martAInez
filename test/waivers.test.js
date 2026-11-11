// U2: waiver email parsing/authorisation, numbering, waivers.txt matching,
// and the extracts status check. Gmail payloads are fake (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseWaiverSubject, parseWaiverBody, parseAddress, processWaiverEmail } from '../lib/waiver-email.js';
import { assignNumbers, readState, writeState } from '../lib/close-state.js';
import { loadWaivers, findWaiver, appendWaivers } from '../lib/waivers.js';
import { extractStatus } from '../lib/month-status.js';
import { cardCsv, ordemCsv } from './fixtures.js';

const b64 = (s) => Buffer.from(s).toString('base64url');
const email = ({ from = 'Nuno <nuno@example.pt>', subject = 'sem fatura', body = '1', extra = [] }) => ({
  headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, ...extra],
  mimeType: 'multipart/alternative',
  parts: [{ mimeType: 'text/plain', body: { data: b64(body) } }],
});

async function withRoot(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oscar-u2-'));
  const prev = { r: process.env.OSCAR_DATA_ROOT, o: process.env.OSCAR_OWNER_EMAILS };
  process.env.OSCAR_DATA_ROOT = root;
  process.env.OSCAR_OWNER_EMAILS = 'nuno@example.pt, Nuno.Alt@Example.PT';
  try { await fn(root); } finally {
    for (const [k, v] of [['OSCAR_DATA_ROOT', prev.r], ['OSCAR_OWNER_EMAILS', prev.o]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

const MISSING = [
  { date: '03/10/2026', description: 'ANUIDADE CARTAO', amount: 45 },
  { date: '05/10/2026', description: 'MC MARSHOPPING', amount: 14.35 },
  { date: '07/10/2026', description: 'COMPRA US 005APT', amount: 40 },
];

async function openMonth(month, items = MISSING) {
  const state = await readState(month);
  state.status = 'open';
  assignNumbers(state, items);
  await writeState(month, state);
}

test('subject: sem fatura / sem factura, Re: prefix, optional month', () => {
  assert.deepEqual(parseWaiverSubject('sem fatura'), { month: null });
  assert.deepEqual(parseWaiverSubject('Re: Sem Factura 2026-10'), { month: '2026-10' });
  assert.deepEqual(parseWaiverSubject('sem fatura 10/2026'), { month: '2026-10' });
  assert.equal(parseWaiverSubject('fatura da sem'), null);
  assert.equal(parseWaiverSubject('Invoice'), null);
});

test('body: numbers, lists, reasons, quotes and signatures', () => {
  assert.deepEqual(parseWaiverBody('3 anuidade cartão'), [{ num: 3, reason: 'anuidade cartão' }]);
  assert.deepEqual(parseWaiverBody('3, 5'), [{ num: 3, reason: '' }, { num: 5, reason: '' }]);
  assert.deepEqual(parseWaiverBody('#3 e 5 estorno'), [{ num: 3, reason: 'estorno' }, { num: 5, reason: 'estorno' }]);
  assert.deepEqual(parseWaiverBody('Olá\n3 - anuidade\n\n> 9 quoted\n-- \n12 signature'), [{ num: 3, reason: 'anuidade' }]);
  assert.deepEqual(parseWaiverBody('3 2x cobrança'), [{ num: 3, reason: '2x cobrança' }]);
  assert.deepEqual(parseWaiverBody('nada aqui'), []);
});

test('parseAddress handles display names and case', () => {
  assert.equal(parseAddress('"Nuno B" <Nuno@Example.pt>'), 'nuno@example.pt');
  assert.equal(parseAddress('nuno@example.pt'), 'nuno@example.pt');
});

test('numbers are assigned on first listing and never reused', async () => {
  await withRoot(async () => {
    const state = await readState('2026-10');
    const a = assignNumbers(state, MISSING.slice(0, 2));
    assert.deepEqual(a.map((x) => x.num), [1, 2]);
    // #1 gets resolved and drops out of the list; a new row must not take #1
    const b = assignNumbers(state, [MISSING[1], MISSING[2]]);
    assert.deepEqual(b.map((x) => x.num), [2, 3]);
    // the same row keeps its number
    assert.equal(assignNumbers(state, [MISSING[0]])[0].num, 1);
  });
});

test('owner email waives by number with reason; waivers.txt then matches the row', async () => {
  await withRoot(async (root) => {
    await openMonth('2026-10');
    const r = await processWaiverEmail({ payload: email({ body: '1 anuidade cartão\n3' }) });
    assert.equal(r.kind, 'handled');
    assert.equal(r.month, '2026-10');
    assert.deepEqual(r.waived, [1, 3]);
    assert.match(r.text, /#1 ANUIDADE CARTAO 45\.00/);
    const file = await fs.readFile(path.join(root, '2026-10', 'waivers.txt'), 'utf8');
    assert.match(file, /03\/10\/2026 \| ANUIDADE CARTAO \| 45\.00 → anuidade cartão/);
    const waivers = await loadWaivers('2026-10');
    assert.ok(findWaiver(waivers, { date: '03/10/2026', description: 'ANUIDADE  CARTAO', amount: 45 }));
    assert.ok(!findWaiver(waivers, { date: '05/10/2026', description: 'MC MARSHOPPING', amount: 14.35 }));
    // re-sending is idempotent
    await processWaiverEmail({ payload: email({ body: '1 anuidade cartão' }) });
    assert.equal((await loadWaivers('2026-10')).length, 2);
  });
});

test('unknown numbers are reported back', async () => {
  await withRoot(async () => {
    await openMonth('2026-10');
    const r = await processWaiverEmail({ payload: email({ body: '2, 9' }) });
    assert.deepEqual(r.waived, [2]);
    assert.deepEqual(r.unknown, [9]);
    assert.match(r.text, /Unknown number: #9/);
  });
});

test('SECURITY: non-owner sender is rejected and nothing is written', async () => {
  await withRoot(async (root) => {
    await openMonth('2026-10');
    const r = await processWaiverEmail({ payload: email({ from: 'Attacker <evil@example.com>', body: '1\n2\n3' }) });
    assert.equal(r.kind, 'rejected');
    await assert.rejects(fs.access(path.join(root, '2026-10', 'waivers.txt')));
    // lookalike display name with a foreign address
    const r2 = await processWaiverEmail({ payload: email({ from: '"nuno@example.pt" <evil@example.com>' }) });
    assert.equal(r2.kind, 'rejected');
  });
});

test('SECURITY: unset OSCAR_OWNER_EMAILS rejects everyone; failed DMARC rejects an owner address', async () => {
  await withRoot(async () => {
    await openMonth('2026-10');
    assert.equal((await processWaiverEmail({ payload: email({}), owners: [] })).kind, 'rejected');
    const spoof = email({ extra: [{ name: 'Authentication-Results', value: 'mx.google.com; dmarc=fail header.from=example.pt' }] });
    assert.equal((await processWaiverEmail({ payload: spoof })).kind, 'rejected');
  });
});

test('owner address matching is case-insensitive and list-based', async () => {
  await withRoot(async () => {
    await openMonth('2026-10');
    const r = await processWaiverEmail({ payload: email({ from: 'NUNO.ALT@example.pt', body: '1' }) });
    assert.equal(r.kind, 'handled');
    assert.deepEqual(r.waived, [1]);
  });
});

test('month resolution: single open month, subject-named month, ambiguity', async () => {
  await withRoot(async () => {
    await openMonth('2026-09', [MISSING[0]]);
    await openMonth('2026-10');
    let r = await processWaiverEmail({ payload: email({ body: '1' }) });
    assert.equal(r.month, null);
    assert.match(r.text, /More than one month is open \(2026-09, 2026-10\)/);
    r = await processWaiverEmail({ payload: email({ subject: 'sem fatura 2026-09', body: '1' }) });
    assert.equal(r.month, '2026-09');
    assert.deepEqual(r.waived, [1]);
    r = await processWaiverEmail({ payload: email({ subject: 'sem fatura 2026-08', body: '1' }) });
    assert.match(r.text, /not open/);
  });
});

test('non-waiver email is ignored', async () => {
  assert.equal((await processWaiverEmail({ payload: email({ subject: 'Fatura Apple' }) })).kind, 'not-waiver');
});

test('waivers.txt: wildcards, comma amounts, comments, malformed lines', async () => {
  await withRoot(async (root) => {
    await fs.mkdir(path.join(root, '2026-10'));
    await fs.writeFile(path.join(root, '2026-10', 'waivers.txt'),
      '# comment\n03/10/2026 | ANUIDADE* | 45,00 → fee\nthis is not valid\n');
    const w = await loadWaivers('2026-10');
    assert.equal(w.length, 1);
    assert.ok(findWaiver(w, { date: '03/10/2026', description: 'anuidade cartao', amount: 45 }));
    assert.ok(!findWaiver(w, { date: '04/10/2026', description: 'anuidade cartao', amount: 45 }));
    assert.ok(!findWaiver(w, { date: '03/10/2026', description: 'anuidade cartao', amount: 46 }));
    assert.equal(await appendWaivers('2026-10', [{ date: '03/10/2026', description: 'ANUIDADE CARTAO', amount: 45, reason: 'x' }]), 0);
  });
});

test('extractStatus: needs ordem for M and card statements M and M+1', async () => {
  await withRoot(async (root) => {
    const dir = path.join(root, '2026-10', 'inputs');
    await fs.mkdir(dir, { recursive: true });
    let s = await extractStatus('2026-10');
    assert.equal(s.ok, false);
    assert.deepEqual(s.missing.map((m) => m.id), ['ext:ordem', 'ext:cartao:2026-10', 'ext:cartao:2026-11']);
    // names are irrelevant: classified by content
    await fs.writeFile(path.join(dir, 'zzz.csv'), ordemCsv('01-07-2026', '31-10-2026'));
    await fs.writeFile(path.join(dir, 'cc-mai.csv'), cardCsv('10-2026'));
    s = await extractStatus('2026-10');
    assert.deepEqual(s.missing.map((m) => m.id), ['ext:cartao:2026-11']);
    await fs.writeFile(path.join(dir, 'ordem-may.csv'), cardCsv('11-2026'));
    s = await extractStatus('2026-10');
    assert.equal(s.ok, true);
  });
});
