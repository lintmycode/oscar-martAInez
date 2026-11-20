// Matcher: identical same-day charges are separate rows (2026-10: an OLX
// payment made twice via PayPal, one invoice each). No OpenAI calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvoiceMatcher } from '../lib/matcher.js';

const txn = () => ({ date: '13/10/2026', vendor: 'PayPal Europe S a r l', rawDescription: 'PayPal Europe S a r l', amount: 4.49, type: 'outgoing' });
const inv = (n) => ({ vendor: 'OLX Portugal S.A.', invoiceNumber: n, date: '10/10/2026', amount: 4.49, currency: 'EUR', source: `${n}.pdf` });

test('two identical same-day charges each get their own invoice', () => {
  const m = new InvoiceMatcher(null, null);
  const transactions = [txn(), txn()];
  const { matched, unmatched } = m.matchAll([inv('A'), inv('B')], transactions);
  assert.equal(matched.length, 2);
  assert.equal(unmatched.length, 0);
  const rows = m.applyMatches(transactions, matched);
  assert.deepEqual(rows.map((r) => r.invoice).sort(), ['A', 'B']);
});
