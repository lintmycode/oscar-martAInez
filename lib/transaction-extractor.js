import { CsvParser } from './csv-parser.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * Extract and normalize transactions from bank/CC CSVs
 */
export class TransactionExtractor {
  /**
   * Detect column mappings from headers (flexible)
   */
  static detectColumns(headers) {
    const mapping = {};

    // Normalize for comparison (remove accents)
    const normalize = (str) => {
      return str.toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
    };

    // Date columns (exclude "Data-valor" / "Data valor")
    mapping.date = headers.find(h => {
      const norm = normalize(h);
      return (norm.includes('data mov') || norm === 'data');
    });

    // Description/vendor columns
    const descPatterns = ['descri', 'description', 'fornecedor', 'vendor'];
    mapping.description = headers.find(h => {
      const norm = normalize(h);
      return descPatterns.some(p => norm.includes(p));
    });

    // Amount columns (debit/credit or single amount)
    const debitPatterns = ['debito', 'debit'];
    const creditPatterns = ['credito', 'credit'];
    const amountPatterns = ['montante', 'amount'];

    mapping.debit = headers.find(h => {
      const norm = normalize(h);
      return debitPatterns.some(p => norm.includes(p));
    });

    mapping.credit = headers.find(h => {
      const norm = normalize(h);
      return creditPatterns.some(p => norm.includes(p));
    });

    mapping.amount = headers.find(h => {
      const norm = normalize(h);
      // Only match "Montante" or "Amount", not "Data-valor"
      return amountPatterns.some(p => norm.includes(p));
    });

    return mapping;
  }

  /**
   * Extract transactions from a single CSV file
   */
  static async extractFromFile(filePath, targetMonth) {
    console.log(`\nProcessing CSV: ${path.basename(filePath)}`);

    const { rows } = await CsvParser.parse(filePath);
    if (rows.length === 0) return [];

    const headers = Object.keys(rows[0]);
    const mapping = this.detectColumns(headers);
    console.log(`  Column mapping:`, mapping);

    const transactions = [];

    for (const row of rows) {
      const dateStr = row[mapping.date] || '';
      const yearMonth = CsvParser.getYearMonth(dateStr);

      // Filter by target month
      if (!yearMonth ||
          yearMonth.year !== targetMonth.year ||
          yearMonth.month !== targetMonth.month) {
        continue;
      }

      // Extract amount (handle debit/credit or single amount)
      let amount = 0;
      let type = 'outgoing'; // 'outgoing' or 'incoming'

      if (mapping.debit && mapping.credit) {
        const debit = CsvParser.parseAmount(row[mapping.debit]);
        const credit = CsvParser.parseAmount(row[mapping.credit]);

        if (debit > 0) {
          amount = debit;
          type = 'outgoing';
        } else if (credit > 0) {
          amount = credit;
          type = 'incoming';
        }
      } else if (mapping.amount) {
        const amt = CsvParser.parseAmount(row[mapping.amount]);

        if (amt < 0) {
          amount = Math.abs(amt);
          type = 'outgoing';
        } else if (amt > 0) {
          amount = amt;
          type = 'incoming';
        }
      }

      // Skip if no amount
      if (amount === 0) continue;

      const description = row[mapping.description] || '';

      const signedAmount = type === 'incoming' ? -amount : amount;

      transactions.push({
        date: CsvParser.parseDate(dateStr),
        vendor: this.cleanVendor(description),
        amount: signedAmount,
        type: type,
        rawDescription: description,
        source: path.basename(filePath),
      });
    }

    const outCount = transactions.filter(t => t.type === 'outgoing').length;
    const inCount = transactions.filter(t => t.type === 'incoming').length;
    console.log(`  Extracted ${transactions.length} transactions (${outCount} out, ${inCount} in)`);
    return transactions;
  }

  /**
   * Clean vendor/description (basic rules, AI can refine later)
   */
  static cleanVendor(description) {
    let cleaned = description;

    // Remove common noise patterns
    cleaned = cleaned.replace(/\s{2,}/g, ' '); // Multiple spaces
    cleaned = cleaned.replace(/[A-Z]{2,3}$/, ''); // Country codes at end
    cleaned = cleaned.replace(/\d{10,}/g, ''); // Long number sequences

    // Trim and capitalize
    cleaned = cleaned.trim();

    return cleaned || description; // Fallback to original
  }

  /**
   * Extract from all CSV files in a directory
   */
  static async extractFromDirectory(inputsDir, targetMonth) {
    const files = await fs.readdir(inputsDir);
    const csvFiles = files.filter(f => f.toLowerCase().endsWith('.csv'));

    console.log(`\nFound ${csvFiles.length} CSV files`);

    const allTransactions = [];

    for (const file of csvFiles) {
      const filePath = path.join(inputsDir, file);
      const transactions = await this.extractFromFile(filePath, targetMonth);
      allTransactions.push(...transactions);
    }

    // Sort by date
    allTransactions.sort((a, b) => {
      const [dayA, monthA, yearA] = a.date.split('/').map(Number);
      const [dayB, monthB, yearB] = b.date.split('/').map(Number);
      const dateA = new Date(yearA, monthA - 1, dayA);
      const dateB = new Date(yearB, monthB - 1, dayB);
      return dateA - dateB;
    });

    const outgoing = allTransactions.filter(t => t.type === 'outgoing').length;
    const incoming = allTransactions.filter(t => t.type === 'incoming').length;

    console.log(`\nTotal transactions: ${allTransactions.length} (${outgoing} outgoing, ${incoming} incoming)`);
    return allTransactions;
  }
}
