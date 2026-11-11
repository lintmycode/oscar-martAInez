#!/usr/bin/env node

import { buildBundle } from './lib/bundle.js';

async function main() {
  console.log('AI Invoice Export Bundle');
  console.log('='.repeat(60));

  try {
    const params = parseArgs();
    const monthStr = `${params.year}-${String(params.month).padStart(2, '0')}`;
    await buildBundle(monthStr);
    console.log('='.repeat(60));
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}\n`);
    process.exit(1);
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  let year = null;
  let month = null;

  for (const arg of args) {
    if (arg.startsWith('--year=') || arg.startsWith('--y=')) {
      year = parseInt(arg.split('=')[1]);
    } else if (arg.startsWith('--month=') || arg.startsWith('--m=')) {
      month = parseInt(arg.split('=')[1]);
    } else if (arg.startsWith('--data-root=')) {
      process.env.OSCAR_DATA_ROOT = arg.split('=').slice(1).join('=');
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
AI Invoice Export Bundle - Package files for accountant delivery

Usage: node export-bundle.js --year=YYYY --month=MM [--data-root=PATH]

Options:
  --year=YYYY, --y=YYYY        Year (e.g., 2025)
  --month=MM, --m=MM           Month (1-12)
  --data-root=PATH             Override data directory (default: ./data)
  --help, -h                   Show this help

Example:
  node export-bundle.js --y=2025 --m=10
  node export-bundle.js --y=2025 --m=10 --data-root=/mnt/echo-ops/tmp/data

This will create a zip file at data/bundles/<company>-export-2025-10.zip containing:
  - *.csv (bank/CC statements)
  - paper/ (invoice photos, shrunk to <= 2000 px / JPEG q85 in the bundle copy only)
  - digital/ (PDF invoices)
  - <company>-2025-10.xlsx (processed accounting sheet)

Only JSON cache files are excluded. The zip file is ready to send
to your accountant.
`);
      process.exit(0);
    }
  }

  if (!year || !month) {
    console.error('\n❌ Error: Missing required arguments\n');
    console.error('Usage: node export-bundle.js --year=YYYY --month=MM');
    console.error('Example: node export-bundle.js --y=2025 --m=10\n');
    process.exit(1);
  }

  if (month < 1 || month > 12) {
    console.error(`\n❌ Error: Invalid month ${month} (must be 1-12)\n`);
    process.exit(1);
  }

  return { year, month };
}

main();
