#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { resolvePaths } from './lib/paths.js';

async function main() {
  console.log('AI Invoice Month Setup');
  console.log('='.repeat(60));

  try {
    const params = parseArgs();
    const monthStr = `${params.year}-${String(params.month).padStart(2, '0')}`;
    const { paperDir, digitalDir, outDir, paramsPath } = resolvePaths(monthStr);

    await fs.mkdir(paperDir, { recursive: true });
    await fs.mkdir(digitalDir, { recursive: true });
    await fs.mkdir(outDir, { recursive: true });

    await ensureParams(paramsPath, params.year, params.month);

    const dataRoot = process.env.OSCAR_DATA_ROOT || 'data';
    console.log(`\n✅ Month structure ready: ${dataRoot}/${monthStr}/`);
    console.log('='.repeat(60));
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}\n`);
    process.exit(1);
  }
}

async function ensureParams(paramsPath, year, month) {
  try {
    await fs.access(paramsPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const content = `year: ${year}\nmonth: ${month}\n`;
    await fs.writeFile(paramsPath, content);
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
AI Invoice Month Setup - Create folder structure for a new month

Usage: node create-month.js --year=YYYY --month=MM [--data-root=PATH]

Options:
  --year=YYYY, --y=YYYY        Year (e.g., 2025)
  --month=MM, --m=MM           Month (1-12)
  --data-root=PATH             Override data directory (default: ./data)
  --help, -h                   Show this help

Example:
  node create-month.js --y=2025 --m=10
  node create-month.js --y=2025 --m=10 --data-root=/mnt/echo-ops/tmp/data

This will create:
  <data-root>/2025-10/inputs/paper/      For invoice photos
  <data-root>/2025-10/inputs/digital/    For PDF invoices
  <data-root>/2025-10/out/               For generated outputs
  <data-root>/2025-10/params.yml         Month configuration

After running this, add your CSV files to <data-root>/2025-10/inputs/
and invoice documents to the paper/ and digital/ subdirectories.
`);
      process.exit(0);
    }
  }

  if (!year || !month) {
    console.error('\n❌ Error: Missing required arguments\n');
    console.error('Usage: node create-month.js --year=YYYY --month=MM');
    console.error('Example: node create-month.js --y=2025 --m=10\n');
    process.exit(1);
  }

  if (month < 1 || month > 12) {
    console.error(`\n❌ Error: Invalid month ${month} (must be 1-12)\n`);
    process.exit(1);
  }

  return { year, month };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
