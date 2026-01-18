#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';

async function main() {
  console.log('AI Invoice Month Setup');
  console.log('='.repeat(60));

  try {
    const params = parseArgs();
    const monthStr = `${params.year}-${String(params.month).padStart(2, '0')}`;
    const monthDir = path.join(process.cwd(), 'data', monthStr);
    const inputsDir = path.join(monthDir, 'inputs');
    const paperDir = path.join(inputsDir, 'paper');
    const digitalDir = path.join(inputsDir, 'digital');
    const outDir = path.join(monthDir, 'out');

    await fs.mkdir(paperDir, { recursive: true });
    await fs.mkdir(digitalDir, { recursive: true });
    await fs.mkdir(outDir, { recursive: true });

    const paramsPath = path.join(monthDir, 'params.yml');
    await ensureParams(paramsPath, params.year, params.month);

    console.log(`\n✅ Month structure ready: data/${monthStr}/`);
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
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
AI Invoice Month Setup - Create folder structure for a new month

Usage: node create-month.js --year=YYYY --month=MM

Options:
  --year=YYYY, --y=YYYY    Year (e.g., 2025)
  --month=MM, --m=MM       Month (1-12)
  --help, -h               Show this help

Example:
  node create-month.js --y=2025 --m=10

This will create:
  data/2025-10/inputs/paper/      For invoice photos
  data/2025-10/inputs/digital/    For PDF invoices
  data/2025-10/out/               For generated outputs
  data/2025-10/params.yml         Month configuration

After running this, add your CSV files to data/2025-10/inputs/
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
