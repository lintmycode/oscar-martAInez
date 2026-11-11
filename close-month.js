#!/usr/bin/env node
// Monthly close: chase what's missing for the previous month, then hand the
// bundle to lib/deliver-bundle.js. See specs/monthly-close.md.
//
//   node close-month.js --due                    daily cron: from the 14th, open M-1 and
//                                                request/remind; bundle when complete;
//                                                on the 20th bundle what exists
//   node close-month.js --month=2026-10          check one month now (always prints the list)
//   node close-month.js --month=2026-10 --rebundle   re-run and send a fresh bundle
//
// Testing: OSCAR_DRY_RUN=1 prints Telegram/email instead of sending (state is
// still written, except bundled* - use a scratch OSCAR_DATA_ROOT);
// OSCAR_TODAY=YYYY-MM-DD fakes today's date.
import 'dotenv/config';
import { checkMonth, runDue } from './lib/close-job.js';
import { parseMonth } from './lib/months.js';
import { say } from './lib/notify-out.js';

function usage() {
  console.log(`Usage: node close-month.js --due | --month=YYYY-MM [--rebundle] [--data-root=PATH]`);
  process.exit(1);
}

async function main() {
  let due = false;
  let month = null;
  let rebundle = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === '--due') due = true;
    else if (arg === '--rebundle') rebundle = true;
    else if (arg.startsWith('--month=')) month = arg.split('=')[1];
    else if (arg.startsWith('--data-root=')) process.env.OSCAR_DATA_ROOT = arg.split('=').slice(1).join('=');
    else usage();
  }
  if (due === Boolean(month)) usage(); // exactly one of --due / --month
  if (rebundle && !month) usage();

  if (due) {
    await runDue();
  } else {
    parseMonth(month); // throws on a bad format
    await checkMonth(month, { trigger: 'manual', rebundle });
  }
}

main().catch(async (err) => {
  console.error(`\n❌ close-month failed: ${err.stack || err.message}\n`);
  // Only the unattended run needs to ping; a manual run already shows the error.
  if (process.argv.includes('--due')) await say('Oscar: close-month failed', err.message);
  process.exit(1);
});
