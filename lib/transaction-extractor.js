import { CsvParser } from './csv-parser.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * Extract and normalize transactions from bank/CC CSVs
 */
export class TransactionExtractor {
  static ignorePatterns = [];

  /**
   * Load vendor ignore strings from file
   */
  static async loadIgnoreWords(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const lines = content.split('\n');

      this.ignorePatterns = lines
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(word => new RegExp(this.escapeRegex(word), 'ig'));

      console.log(`Loaded ${this.ignorePatterns.length} ignore words from ${path.basename(filePath)}`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('No ignore-words.txt found, vendor cleanup unchanged');
      } else {
        console.warn(`Warning: Could not load ignore words: ${error.message}`);
      }
    }
  }

  static escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

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

    // Date columns (support "Data valor", "Data-valor", "Data mov.", and plain "Data")
    // Normalize by removing dots and converting spaces/hyphens to single space
    const normalizeDateHeader = (h) =>
      normalize(h).replace(/\./g, '').replace(/[-\s]+/g, ' ').trim();

    // Find any header containing "data valor" or "data mov"
    const dataValorHeader = headers.find(h => {
      const norm = normalizeDateHeader(h);
      return norm.includes('data valor') || norm.includes('data mov');
    });

    const dataHeader = headers.find(h =>
      normalizeDateHeader(h) === 'data'
    );

    // Use data-valor/data-mov column if available, otherwise fallback to plain "Data"
    mapping.date = dataValorHeader || dataHeader;

    // Description/vendor columns (fallback to "Tipo operação" for bank statements)
    const descPatterns = ['descri', 'description', 'fornecedor', 'vendor', 'tipo opera'];
    mapping.description = headers.find(h => {
      const norm = normalize(h);
      return descPatterns.some(p => norm.includes(p));
    });

    // Amount columns (debit/credit or single amount)
    const debitPatterns = ['debito', 'debit'];
    const creditPatterns = ['credito', 'credit'];
    const amountPatterns = ['montante', 'amount', 'movimento']; // "Movimento" is used in extracto-ordem

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
      // Match "Montante", "Amount", or "Movimento" (but not "Data-valor")
      return amountPatterns.some(p => norm.includes(p)) && !norm.includes('data');
    });

    return mapping;
  }

  /**
   * Extract transactions from a single CSV file
   * Note: Processes ALL rows from the CSV but only saves transactions matching targetMonth
   * This is required because CC statements span billing cycles (e.g., Jan statement contains Dec-Jan)
   */
  static async extractFromFile(filePath, targetMonth) {
    console.log(`\nProcessing CSV: ${path.basename(filePath)}`);

    const { rows } = await CsvParser.parse(filePath);
    if (rows.length === 0) return [];

    const headers = Object.keys(rows[0]);
    const mapping = this.detectColumns(headers);
    console.log(`  Column mapping:`, mapping);

    const transactions = [];
    let processedCount = 0;

    for (const row of rows) {
      const dateStr = row[mapping.date] || '';
      processedCount++;

      // Parse date and filter by target month
      const yearMonth = CsvParser.getYearMonth(dateStr);

      // Skip if not in target month
      if (!yearMonth || !targetMonth ||
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

        // Single-amount-column CSVs (e.g. extracto-ordem "Movimento"): sign indicates direction
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

      // Skip summary/total rows (e.g., "Totais", "Total")
      if (!description || description.trim().toLowerCase().match(/^(totais|total|totales)$/)) {
        continue;
      }

      const matchVendor = this.cleanVendor(description);
      const signedAmount = type === 'incoming' ? -amount : amount;

      transactions.push({
        date: CsvParser.parseDate(dateStr),
        vendor: description.trim() || matchVendor,
        matchVendor,
        amount: signedAmount,
        type: type,
        rawDescription: description,
        source: path.basename(filePath),
      });
    }

    const outCount = transactions.filter(t => t.type === 'outgoing').length;
    const inCount = transactions.filter(t => t.type === 'incoming').length;
    console.log(`  Processed ${processedCount} rows → Extracted ${transactions.length} transactions for target month (${outCount} out, ${inCount} in)`);
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

    // Remove ignored tokens (e.g., "COMPRA")
    for (const pattern of this.ignorePatterns) {
      cleaned = cleaned.replace(pattern, ' ');
    }

    // Trim and capitalize
    cleaned = cleaned.replace(/\s{2,}/g, ' ');
    cleaned = cleaned.trim();

    return cleaned || description; // Fallback to original
  }

  /**
   * Extract from all CSV files in a directory
   * Note: Processes ALL CSVs but only saves transactions matching targetMonth
   * This allows CC billing cycles to span months (e.g., Jan needs Jan+Feb CSVs)
   */
  static async extractFromDirectory(inputsDir, targetMonth) {
    const files = await fs.readdir(inputsDir);
    const csvFiles = files.filter(f => f.toLowerCase().endsWith('.csv'));

    console.log(`\nFound ${csvFiles.length} CSV files`);
    console.log(`Target month: ${targetMonth.year}-${String(targetMonth.month).padStart(2, '0')}`);
    console.log('Note: Processing all CSVs but saving only target month transactions');

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
