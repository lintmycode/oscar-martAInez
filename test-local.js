#!/usr/bin/env node

/**
 * Test script - runs without OpenAI API to validate CSV parsing
 */

import { TransactionExtractor } from './lib/transaction-extractor.js';
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
  const targetMonth = { year, month };

  try {
    const transactions = await TransactionExtractor.extractFromDirectory(
      inputsDir,
      targetMonth
    );

    console.log('\n' + '='.repeat(60));
    console.log('EXTRACTED TRANSACTIONS');
    console.log('='.repeat(60));

    transactions.forEach((txn, idx) => {
      console.log(
        `${(idx + 1).toString().padStart(3)}. ${txn.date}  ` +
        `${txn.vendor.padEnd(35)}  ${txn.amount.toFixed(2).padStart(8)}€`
      );
    });

    console.log('='.repeat(60));
    console.log(`Total: ${transactions.length} transactions`);
    console.log('='.repeat(60));

    console.log('\n✅ CSV parsing works! Ready to add OpenAI API key.\n');

  } catch (error) {
    console.error(`\n❌ Error: ${error.message}\n`);
    process.exit(1);
  }
}

test();
