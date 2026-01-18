#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { CONFIG } from './config.js';

async function main() {
  console.log('AI Invoice Export Bundle');
  console.log('='.repeat(60));

  try {
    const params = parseArgs();
    const monthStr = `${params.year}-${String(params.month).padStart(2, '0')}`;
    const monthDir = path.join(process.cwd(), 'data', monthStr);
    const inputsDir = path.join(monthDir, 'inputs');
    const outDir = path.join(monthDir, 'out');
    const exportDir = path.join(monthDir, 'export');

    await fs.mkdir(exportDir, { recursive: true });

    const copied = await copyInputsStructured(inputsDir, exportDir);

    const companyName = sanitizeName(CONFIG.company?.name || 'company');
    const exportXlsxName = `${companyName}-${monthStr}.xlsx`;
    const xlsxPath = path.join(outDir, `${monthStr}.xlsx`);
    await copyIfExists(xlsxPath, path.join(exportDir, exportXlsxName));

    console.log(`\nExported ${copied} input files + ${exportXlsxName} to data/${monthStr}/export/`);
    console.log('='.repeat(60));
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}\n`);
    process.exit(1);
  }
}

async function copyInputsStructured(inputsDir, exportDir) {
  let count = 0;
  const entries = await fs.readdir(inputsDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(inputsDir, entry.name);
    if (entry.isFile()) {
      if (path.extname(entry.name).toLowerCase() === '.json') continue;
      const destPath = path.join(exportDir, entry.name);
      await fs.copyFile(srcPath, destPath);
      count += 1;
    } else if (entry.isDirectory()) {
      const destDir = path.join(exportDir, entry.name);
      count += await copyDirectory(srcPath, destDir);
    }
  }

  return count;
}

async function copyDirectory(srcDir, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  let count = 0;

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      count += await copyDirectory(srcPath, destPath);
    } else if (entry.isFile()) {
      if (path.extname(entry.name).toLowerCase() === '.json') continue;
      await fs.copyFile(srcPath, destPath);
      count += 1;
    }
  }

  return count;
}

async function copyIfExists(src, dest) {
  try {
    await fs.copyFile(src, dest);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn(`\n⚠️  XLSX not found at ${src}`);
      return;
    }
    throw error;
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
Usage: node export-bundle.js --year=YYYY --month=MM

Options:
  --year=YYYY, --y=YYYY    Year (e.g., 2025)
  --month=MM, --m=MM       Month (1-12)
  --help, -h               Show this help
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

function sanitizeName(name) {
  return name
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'company';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
