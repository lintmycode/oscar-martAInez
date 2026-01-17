#!/usr/bin/env node

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import yaml from 'js-yaml';
import { CONFIG } from './config.js';
import { TransactionExtractor } from './lib/transaction-extractor.js';
import { InvoiceExtractor } from './lib/invoice-extractor.js';
import { InvoiceMatcher } from './lib/matcher.js';
import { XlsxGenerator } from './lib/xlsx-generator.js';
import { TokenTracker } from './lib/token-tracker.js';

/**
 * Main CLI entry point
 */
async function main() {
  console.log('AI Invoice Automation CLI');
  console.log('='.repeat(60));

  try {
    // 1. Parse CLI arguments
    const params = parseArgs();
    const monthStr = `${params.year}-${String(params.month).padStart(2, '0')}`;
    console.log(`\nTarget month: ${monthStr}`);

    // 2. Set up paths for this month
    const monthDir = path.join(process.cwd(), 'data', monthStr);
    const inputsDir = path.join(monthDir, 'inputs');
    const outDir = path.join(monthDir, 'out');

    // 3. Check month directory exists
    try {
      await fs.access(monthDir);
    } catch {
      throw new Error(
        `Directory data/${monthStr}/ not found.\n` +
        `Please create it and add your CSV files and invoice documents.`
      );
    }

    console.log(`Working directory: data/${monthStr}/`);

    // 4. Ensure output directory exists
    await fs.mkdir(outDir, { recursive: true });

    // 4b. Read optional params.yml for additional settings (e.g., remain)
    const paramsPath = path.join(monthDir, 'params.yml');
    let personalRemain = 0;
    try {
      const paramsRaw = await fs.readFile(paramsPath, 'utf8');
      const paramsYaml = yaml.load(paramsRaw) || {};
      const parsedRemain = Number(paramsYaml.remain);
      if (Number.isFinite(parsedRemain)) {
        personalRemain = parsedRemain;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    // 5. Initialize OpenAI client (optional for now)
    const tokenTracker = new TokenTracker();
    let openaiClient = null;

    if (CONFIG.openai.apiKey) {
      openaiClient = new OpenAI({ apiKey: CONFIG.openai.apiKey });
      console.log(`\n✓ OpenAI API key configured (model: ${CONFIG.openai.model})`);
      console.log(`  Token budget: ${CONFIG.budget.maxTokensPerRun.toLocaleString()}`);
    } else {
      console.log('\n⚠️  No OpenAI API key found (set OPENAI_API_KEY env var)');
      console.log('   Running in local-only mode (limited invoice extraction)');
    }

    // 6. Extract transactions from CSVs (from data/YYYY-MM/inputs/*.csv)
    const transactions = await TransactionExtractor.extractFromDirectory(
      inputsDir,
      { year: params.year, month: params.month }
    );

    if (transactions.length === 0) {
      throw new Error('No transactions found for the specified month');
    }

    // 7. Extract invoice data (from data/YYYY-MM/inputs/paper/ and data/YYYY-MM/inputs/digital/)
    // Cached data saved as sidecar JSON files (e.g., invoice.pdf -> invoice.json)
    const invoiceExtractor = new InvoiceExtractor(openaiClient, tokenTracker);
    const paperDir = path.join(inputsDir, 'paper');
    const digitalDir = path.join(inputsDir, 'digital');

    const invoices = await invoiceExtractor.extractAll(
      paperDir,
      digitalDir
    );

    // 8. Match invoices to transactions
    const matcher = new InvoiceMatcher(openaiClient, tokenTracker);
    const { matched, unmatched } = matcher.matchAll(invoices, transactions);

    // 9. Generate sheets
    const companyRows = matcher.applyMatches(transactions, matched);
    const personalRows = matcher.createPersonalSheet(unmatched);

    // 10. Generate XLSX (saved to data/YYYY-MM/out/)
    const generator = new XlsxGenerator();
    const xlsxPath = path.join(outDir, `${monthStr}.xlsx`);

    await generator.generate(companyRows, personalRows, xlsxPath, { personalRemain });

    // 11. Export debug CSVs (saved to data/YYYY-MM/out/)
    await generator.exportCsv(companyRows, personalRows, outDir);

    // 12. Print token usage report
    if (openaiClient) {
      tokenTracker.printReport();
    }

    // 13. Summary
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    console.log(`Company transactions:  ${companyRows.length}`);
    console.log(`  - With invoice:      ${matched.length}`);
    console.log(`  - Without invoice:   ${companyRows.length - matched.length}`);
    console.log(`Personal expenses:     ${personalRows.length}`);
    console.log(`Total invoices:        ${invoices.length}`);
    console.log(`\nOutput saved to: data/${monthStr}/out/`);
    console.log('='.repeat(60));

    console.log('\n✅ Processing complete!\n');
    process.exit(0);

  } catch (error) {
    console.error(`\n❌ Error: ${error.message}\n`);
    process.exit(1);
  }
}

/**
 * Parse CLI arguments
 */
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
Usage: node index.js --year=YYYY --month=MM

Options:
  --year=YYYY, --y=YYYY    Year (e.g., 2025)
  --month=MM, --m=MM       Month (1-12)
  --help, -h               Show this help

Example:
  node index.js --y=2025 --m=10

This will process data/2025-10/ and save outputs to data/2025-10/out/
`);
      process.exit(0);
    }
  }

  if (!year || !month) {
    console.error('\n❌ Error: Missing required arguments\n');
    console.error('Usage: node index.js --year=YYYY --month=MM');
    console.error('Example: node index.js --y=2025 --m=10\n');
    console.error('Run with --help for more options\n');
    process.exit(1);
  }

  if (month < 1 || month > 12) {
    console.error(`\n❌ Error: Invalid month ${month} (must be 1-12)\n`);
    process.exit(1);
  }

  return { year, month };
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
