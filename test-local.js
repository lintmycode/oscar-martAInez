#!/usr/bin/env node

/**
 * Test script - validates CSV parsing and generates sidecar JSON for transactions
 */

import { TransactionExtractor } from './lib/transaction-extractor.js';
import { ExclusionFilter } from './lib/exclusion-filter.js';
import { TransactionGrouper } from './lib/transaction-grouper.js';
import fs from 'fs/promises';
import path from 'path';

async function test() {
  // Parse CLI arguments
  const args = process.argv.slice(2);
  let year = null;
  let month = null;

  for (const arg of args) {
    if (arg.startsWith('--year=') || arg.startsWith('--y=')) {
      year = parseInt(arg.split('=')[1]);
    } else if (arg.startsWith('--month=') || arg.startsWith('--m=')) {
      month = parseInt(arg.split('=')[1]);
    }
  }

  if (!year || !month) {
    console.error('\nUsage: node test-local.js --year=YYYY --month=MM');
    console.error('Example: node test-local.js --y=2025 --m=10\n');
    process.exit(1);
  }

  const monthStr = `${year}-${String(month).padStart(2, '0')}`;
  console.log(`Testing CSV extraction for ${monthStr} (no API calls)...\n`);

  const monthDir = path.join(process.cwd(), 'data', monthStr);
  const inputsDir = path.join(monthDir, 'inputs');
  const outDir = path.join(monthDir, 'out');
  const targetMonth = { year, month };

  try {
    let transactions = await TransactionExtractor.extractFromDirectory(
      inputsDir,
      targetMonth
    );

    // Apply exclusion filter
    const exclusionFilter = new ExclusionFilter();
    const exclusionsFile = path.join(process.cwd(), 'exclusions.txt');
    await exclusionFilter.load(exclusionsFile);
    transactions = exclusionFilter.filter(transactions);

    // Group related transactions
    const grouper = new TransactionGrouper();
    const groupingFile = path.join(process.cwd(), 'grouping-rules.txt');
    await grouper.load(groupingFile);
    transactions = grouper.group(transactions);

    console.log('\n' + '='.repeat(60));
    console.log('EXTRACTED TRANSACTIONS');
    console.log('='.repeat(60));

    transactions.forEach((txn, idx) => {
      const typeIcon = txn.type === 'outgoing' ? '−' : '+';
      const typeLabel = txn.type === 'outgoing' ? 'OUT' : 'IN';
      const displayAmount = Math.abs(txn.amount);
      console.log(
        `${(idx + 1).toString().padStart(3)}. ${txn.date}  ` +
        `${txn.vendor.padEnd(35)}  ${typeIcon}${displayAmount.toFixed(2).padStart(8)}€ [${typeLabel}]`
      );
    });

    console.log('='.repeat(60));
    console.log(`Total: ${transactions.length} transactions`);
    console.log('='.repeat(60));

    // Save transactions to sidecar JSON
    await fs.mkdir(outDir, { recursive: true });
    const sidecarPath = path.join(outDir, 'transactions.json');
    await fs.writeFile(sidecarPath, JSON.stringify(transactions, null, 2));

    console.log(`\n💾 Transactions saved to: data/${monthStr}/out/transactions.json`);
    console.log('\n✅ CSV parsing works! Ready to add OpenAI API key.\n');

  } catch (error) {
    console.error(`\n❌ Error: ${error.message}\n`);
    process.exit(1);
  }
}

test();
