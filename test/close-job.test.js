// U3: close job scheduling logic (request / throttled reminders / 20th deadline /
// late arrival). Uses a month with NO extracts so the pipeline (OpenAI etc.)
// never runs; the complete-month path is covered by the dry-run demo in the PR.
// Everything runs with OSCAR_DRY_RUN=1, so "Telegram" goes to console.log,
// which the tests capture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function withEnv(today, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oscar-u3-'));
  const keep = { ...process.env };
  Object.assign(process.env, { OSCAR_DATA_ROOT: root, OSCAR_DRY_RUN: '1', OSCAR_TODAY: today, OSCAR_REPORT_TO: 'test@example.invalid' });
  try { await fn(root); } finally {
    process.env = keep;
    await fs.rm(root, { recursive: true, force: true });
  }
}

function capture(t) {
  const lines = [];
  t.mock.method(console, 'log', (...a) => lines.push(a.join(' ')));
  return lines;
}
const sent = (lines) => lines.flatMap((l) => l.split('\n')).filter((l) => l.includes('[DRY RUN - Telegram]'));

test('--due: nothing before the 14th, request on the 14th, quiet repeat, daily reminder', async (t) => {
  const { runDue } = await import('../lib/close-job.js');
  await withEnv('2026-11-13', async (root) => {
    await fs.mkdir(path.join(root, '2026-10', 'inputs'), { recursive: true });
    const lines = capture(t);

    await runDue();
    assert.deepEqual(sent(lines), []);

    process.env.OSCAR_TODAY = '2026-11-14';
    await runDue();
    assert.equal(sent(lines).length, 1);
    assert.match(sent(lines)[0], /closing October 2026/);
    assert.match(lines.join('\n'), /card statement 11-2026/);
    const state = JSON.parse(await fs.readFile(path.join(root, '2026-10', 'close.json'), 'utf8'));
    assert.equal(state.status, 'open');

    await runDue(); // same day again: no second message
    assert.equal(sent(lines).length, 1);

    process.env.OSCAR_TODAY = '2026-11-15';
    await runDue();
    assert.equal(sent(lines).length, 2);
    assert.match(sent(lines)[1], /still missing for October 2026/);
  });
});

test('--due on the 20th declares the deadline for a still-incomplete month', async (t) => {
  const { runDue } = await import('../lib/close-job.js');
  await withEnv('2026-11-14', async (root) => {
    await fs.mkdir(path.join(root, '2026-10', 'inputs'), { recursive: true });
    const lines = capture(t);
    await runDue(); // opens + requests
    process.env.OSCAR_TODAY = '2026-11-20';
    await runDue();
    assert.match(sent(lines).at(-1), /October 2026 deadline/);
  });
});

test('first look after the 20th is a request, not an instant deadline bundle', async (t) => {
  const { runDue } = await import('../lib/close-job.js');
  await withEnv('2026-11-22', async (root) => {
    await fs.mkdir(path.join(root, '2026-10', 'inputs'), { recursive: true });
    const lines = capture(t);
    await runDue();
    assert.match(sent(lines)[0], /closing October 2026/);
  });
});

test('poll trigger stays quiet when the missing list did not change', async (t) => {
  const { checkMonth } = await import('../lib/close-job.js');
  await withEnv('2026-11-14', async (root) => {
    await fs.mkdir(path.join(root, '2026-10', 'inputs'), { recursive: true });
    const lines = capture(t);
    assert.equal(await checkMonth('2026-10', { trigger: 'manual' }), 'requested');
    assert.equal(await checkMonth('2026-10', { trigger: 'poll' }), 'silent');
    // an ordem extract lands: the list changed, so poll speaks up
    const { ordemCsv } = await import('./fixtures.js');
    await fs.writeFile(path.join(root, '2026-10', 'inputs', 'x.csv'), ordemCsv('01-10-2026', '31-10-2026'));
    assert.equal(await checkMonth('2026-10', { trigger: 'poll' }), 'reminded');
    assert.match(lines.join('\n'), /1 of 3 found since last time/);
  });
});

test('late arrival in a bundled month is flagged, never re-sent', async (t) => {
  const { afterFiling } = await import('../lib/close-job.js');
  const { writeState, readState } = await import('../lib/close-state.js');
  await withEnv('2026-11-25', async (root) => {
    await fs.mkdir(path.join(root, '2026-10'), { recursive: true });
    const s = await readState('2026-10');
    s.status = 'bundled';
    await writeState('2026-10', s);
    const lines = capture(t);
    await afterFiling(['2026-10', '2026-11']);
    assert.match(sent(lines)[0], /late arrival for 2026-10/);
    assert.match(lines.join('\n'), /--rebundle/);
    assert.equal(sent(lines).length, 1);
  });
});
