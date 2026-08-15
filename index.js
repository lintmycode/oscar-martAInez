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
import { PersonalExceptionFilter } from './lib/personal-exception-filter.js';
import { ExclusionFilter } from './lib/exclusion-filter.js';
import { TransactionGrouper } from './lib/transaction-grouper.js';
import { TransactionNotes } from './lib/transaction-notes.js';
import { resolvePaths, resolveConfigPaths } from './lib/paths.js';

/**
 * Main CLI entry point
 */
async function main() {
  console.log('oscar-martAInez CLI');
  console.log('='.repeat(60));

  try {
    // 1. Parse CLI arguments
    const params = parseArgs();
    const monthStr = `${params.year}-${String(params.month).padStart(2, '0')}`;
    console.log(`\nTarget month: ${monthStr}`);

    // 2. Set up paths for this month
    const { monthDir, inputsDir, outDir, paramsPath, xlsxPath, paperDir, digitalDir } = resolvePaths(monthStr);
    const { exclusionsFile, personalExceptionsFile, ignoreWordsFile, groupingFile, transactionNotesFile } = resolveConfigPaths();

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

    // 4b. Determine personal carryover ("remain"): the balance the company still
    // owes for personal-funded expenses. Auto-detected from the previous month's
    // summary.json, but an explicit `remain:` in this month's params.yml always wins.
    let personalRemain = 0;
    let remainSource = 'default (no prior month found, starting at €0)';

    const prevMonthStr = getPrevMonthStr(params.year, params.month);
    const { outDir: prevOutDir } = resolvePaths(prevMonthStr);
    try {
      const prevSummaryRaw = await fs.readFile(path.join(prevOutDir, 'summary.json'), 'utf8');
      const prevSummary = JSON.parse(prevSummaryRaw);
      if (Number.isFinite(prevSummary.personalTotalCombined)) {
        personalRemain = prevSummary.personalTotalCombined;
        remainSource = `auto-carried from ${prevMonthStr} (€${personalRemain.toFixed(2)})`;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`Warning: Could not read ${prevMonthStr}/out/summary.json: ${error.message}`);
      }
    }

    try {
      const paramsRaw = await fs.readFile(paramsPath, 'utf8');
      const paramsYaml = yaml.load(paramsRaw) || {};
      const parsedRemain = Number(paramsYaml.remain);
      if (Number.isFinite(parsedRemain)) {
        personalRemain = parsedRemain;
        remainSource = `override from params.yml (€${personalRemain.toFixed(2)})`;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    console.log(`Personal carryover (remain): ${remainSource}`);

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

    // 6. Load vendor ignore words (optional)
    await TransactionExtractor.loadIgnoreWords(ignoreWordsFile);

    // 7. Extract transactions from CSVs (from data/YYYY-MM/inputs/*.csv)
    // Note: Processes ALL CSVs (e.g., Jan+Feb for January) but saves only target month transactions
    // This handles CC billing cycles that span months while keeping output clean
    let transactions = await TransactionExtractor.extractFromDirectory(
      inputsDir,
      { year: params.year, month: params.month }
    );

    if (transactions.length === 0) {
      throw new Error('No transactions found for the specified month');
    }

    console.log(`\nExtracted ${transactions.length} movements for ${monthStr}`);
    console.log('  - All will be inserted as company expenses');
    console.log('  - Then matched against invoices');
    console.log('  - Unmatched invoices → personal account\n');

    // 7b. Apply exclusion filter
    const exclusionFilter = new ExclusionFilter();
    await exclusionFilter.load(exclusionsFile);
    transactions = exclusionFilter.filter(transactions);

    // 7c. Group related transactions (e.g., Via Verde tolls)
    const grouper = new TransactionGrouper();
    await grouper.load(groupingFile);
    transactions = grouper.group(transactions);

    // 7d. Move personal exceptions out of company transactions
    const personalExceptionFilter = new PersonalExceptionFilter();
    await personalExceptionFilter.load(personalExceptionsFile);
    const split = personalExceptionFilter.split(transactions);
    const personalExceptionRows = split.personal.map(txn => ({
      date: txn.date,
      vendor: txn.vendor,
      amount: -Math.abs(txn.amount),
      invoice: '',
      file: '',
      notes: `Personal exception (${txn.source})`,
    }));
    transactions = split.remaining;

    // 7. Extract invoice data (from data/YYYY-MM/inputs/paper/ and data/YYYY-MM/inputs/digital/)
    // Cached data saved as sidecar JSON files (e.g., invoice.pdf -> invoice.json)
    const invoiceExtractor = new InvoiceExtractor(openaiClient, tokenTracker);

    const invoices = await invoiceExtractor.extractAll(
      paperDir,
      digitalDir
    );

    // 8. Match invoices to transactions
    const matcher = new InvoiceMatcher(openaiClient, tokenTracker);
    const { matched, unmatched } = matcher.matchAll(invoices, transactions);

    // 9. Generate sheets
    // Company account: ALL movements from CSVs (matched with invoices)
    const companyRows = matcher.applyMatches(transactions, matched);

    // 9b. Apply explanatory notes to unmatched rows that will never have an
    // invoice (bank errors, returned transfers, etc.) - see transaction-notes.txt
    const transactionNotes = new TransactionNotes();
    await transactionNotes.load(transactionNotesFile);
    for (const row of companyRows) {
      if (!row.notes) {
        const note = transactionNotes.getNote(row.rawDescription || row.vendor);
        if (note) row.notes = note;
      }
    }

    // Personal account:
    // - Personal exceptions (e.g., DESPESAS, LEVANTAMENTO)
    // - Unmatched invoices (invoices without a corresponding movement)
    const personalRows = personalExceptionRows.concat(
      matcher.createPersonalSheet(unmatched)
    );

    // 10. Generate XLSX (saved to data/YYYY-MM/out/)
    const generator = new XlsxGenerator();

    await generator.generate(companyRows, personalRows, xlsxPath, { personalRemain });

    // 11. Export debug CSVs (saved to data/YYYY-MM/out/)
    await generator.exportCsv(companyRows, personalRows, outDir);

    // 11b. Write summary.json - machine-readable run report, and the source
    // the NEXT month's run reads to auto-carry the personal balance forward
    const personalTotalCorrente = personalRows.reduce((sum, r) => sum + r.amount, 0);
    const personalTotalCombined = personalTotalCorrente + personalRemain;
    const cost = tokenTracker.calculateCost();

    const summary = {
      month: monthStr,
      generatedAt: new Date().toISOString(),
      companyRows: companyRows.length,
      matchedInvoices: matched.length,
      unmatchedInvoices: unmatched.length,
      personalRows: personalRows.length,
      invoices: invoices.length,
      personalRemainUsed: personalRemain,
      personalTotalCorrente,
      personalTotalCombined,
      tokensUsed: tokenTracker.totalInput + tokenTracker.totalOutput,
      estimatedCostUsd: cost.total,
    };

    await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(`📊 Summary saved: data/${monthStr}/out/summary.json`);

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
 * Get the previous month string (e.g. "2026-04" -> "2026-03"), handling year rollover
 */
function getPrevMonthStr(year, month) {
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  return `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
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
    } else if (arg.startsWith('--data-root=')) {
      // Set env var so lib/paths.js picks it up
      process.env.OSCAR_DATA_ROOT = arg.split('=').slice(1).join('=');
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
oscar-martAInez - Process monthly accounting sheets

Usage: node index.js --year=YYYY --month=MM [--data-root=PATH]

Options:
  --year=YYYY, --y=YYYY        Year (e.g., 2025)
  --month=MM, --m=MM           Month (1-12)
  --data-root=PATH             Override data directory (default: ./data)
  --help, -h                   Show this help

Data root resolution order:
  1. --data-root=<path> CLI flag
  2. OSCAR_DATA_ROOT environment variable
  3. ./data (default, relative to cwd)

Examples:
  node index.js --y=2025 --m=10
  node index.js --y=2025 --m=10 --data-root=/mnt/echo-ops/tmp/data
  OSCAR_DATA_ROOT=/mnt/echo-ops/tmp/data node index.js --y=2025 --m=10

This will:
  1. Extract transactions from CSV files in <data-root>/2025-10/inputs/
  2. Extract invoice data from paper/ and digital/ subdirectories
  3. Apply filters (exclusions.txt, personal-exceptions.txt)
  4. Group related transactions (grouping-rules.txt)
  5. Match invoices to transactions using AI
  6. Generate <data-root>/2025-10/out/2025-10.xlsx with company and personal sheets

Additional commands:
  node create-month.js --y=2025 --m=10      Create month folder structure
  node export-bundle.js --y=2025 --m=10     Package files for accountant
  node test-local.js --y=2025 --m=10        Test CSV parsing (no API cost)
  node validate-images.js --y=2025 --m=10   Check/fix unsupported images
  node validate-images.js --y=2025 --m=10 --fix   Auto-convert HEIF to JPEG

Configuration files (project root):
  exclusions.txt              Transactions to exclude entirely
  personal-exceptions.txt     Route to personal account
  ignore-words.txt            Vendor name cleanup patterns
  grouping-rules.txt          Auto-group related transactions
  config.js                   OpenAI settings and thresholds
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
