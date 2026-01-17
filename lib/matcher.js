import stringSimilarity from 'string-similarity';
import { CONFIG } from '../config.js';

/**
 * Match invoices to transactions using scoring algorithm
 */
export class InvoiceMatcher {
  constructor(openaiClient, tokenTracker) {
    this.openai = openaiClient;
    this.tokenTracker = tokenTracker;
  }

  /**
   * Calculate match score between invoice and transaction
   */
  calculateScore(invoice, transaction) {
    let score = 0;

    // 1. Amount match (most important)
    const amountDiff = Math.abs(invoice.amount - transaction.amount);
    if (amountDiff <= CONFIG.matching.amountTolerance) {
      if (amountDiff === 0) {
        score += 50; // Exact match
      } else {
        score += 40 - (amountDiff * 20); // Close match
      }
    }

    // 2. Date proximity
    const invoiceDate = this.parseDate(invoice.date);
    const transactionDate = this.parseDate(transaction.date);

    if (invoiceDate && transactionDate) {
      const daysDiff = Math.abs(
        (invoiceDate - transactionDate) / (1000 * 60 * 60 * 24)
      );

      if (daysDiff <= CONFIG.matching.dateProximityDays) {
        score += 30 - (daysDiff * 3);
      }
    }

    // 3. Vendor similarity (fuzzy match)
    const similarity = stringSimilarity.compareTwoStrings(
      this.normalizeVendor(invoice.vendor),
      this.normalizeVendor(transaction.vendor)
    );

    if (similarity >= CONFIG.matching.vendorSimilarityThreshold) {
      score += similarity * 20;
    }

    return score;
  }

  /**
   * Parse dd/mm/yyyy to Date object
   */
  parseDate(dateStr) {
    if (!dateStr) return null;
    const match = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!match) return null;
    const [, day, month, year] = match;
    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  }

  /**
   * Normalize vendor name for comparison
   */
  normalizeVendor(vendor) {
    return vendor
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Find best match for an invoice
   */
  findBestMatch(invoice, transactions) {
    const candidates = transactions.map(txn => ({
      transaction: txn,
      score: this.calculateScore(invoice, txn),
    }));

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    const best = candidates[0];

    // If score is too low, no match
    if (!best || best.score < 40) {
      return null;
    }

    // Check for ambiguity (multiple similar scores)
    const secondBest = candidates[1];
    if (secondBest && Math.abs(best.score - secondBest.score) < 10) {
      return {
        match: null,
        ambiguous: true,
        candidates: candidates.slice(0, 3),
      };
    }

    return {
      match: best.transaction,
      score: best.score,
      ambiguous: false,
    };
  }

  /**
   * Match all invoices to transactions
   */
  matchAll(invoices, transactions) {
    console.log(`\nMatching ${invoices.length} invoices to ${transactions.length} transactions...`);

    const matched = [];
    const unmatched = [];
    const usedTransactionIds = new Set();

    for (const invoice of invoices) {
      // Only consider transactions not already matched
      const available = transactions.filter(
        txn => !usedTransactionIds.has(this.getTxnId(txn))
      );

      const result = this.findBestMatch(invoice, available);

      if (result && result.match) {
        matched.push({
          invoice,
          transaction: result.match,
          score: result.score,
        });
        usedTransactionIds.add(this.getTxnId(result.match));
        console.log(
          `  ✓ Matched: ${invoice.vendor} (${invoice.amount}€) -> ` +
          `${result.match.vendor} (score: ${result.score.toFixed(1)})`
        );
      } else if (result && result.ambiguous) {
        unmatched.push(invoice);
        console.log(
          `  ? Ambiguous: ${invoice.vendor} (${invoice.amount}€) - ` +
          `multiple candidates`
        );
      } else {
        unmatched.push(invoice);
        console.log(`  ✗ No match: ${invoice.vendor} (${invoice.amount}€)`);
      }
    }

    console.log(`\nMatching complete: ${matched.length} matched, ${unmatched.length} unmatched`);

    return { matched, unmatched };
  }

  /**
   * Create unique ID for transaction
   */
  getTxnId(txn) {
    return `${txn.date}_${txn.amount}_${txn.vendor}`;
  }

  /**
   * Apply matches to transaction list
   */
  applyMatches(transactions, matches) {
    const result = transactions.map(txn => ({
      date: txn.date,
      vendor: txn.vendor,
      amount: txn.amount,
      invoice: '',
      notes: '',
      rawDescription: txn.rawDescription,
    }));

    // Fill in invoice numbers from matches
    for (const match of matches) {
      const txnId = this.getTxnId(match.transaction);
      const index = result.findIndex(
        r => this.getTxnId(r) === txnId
      );

      if (index !== -1) {
        result[index].invoice = match.invoice.invoiceNumber || match.invoice.source;
        result[index].notes = `Match score: ${match.score.toFixed(1)}`;
      }
    }

    return result;
  }

  /**
   * Create personal account sheet from unmatched invoices
   */
  createPersonalSheet(unmatchedInvoices) {
    return unmatchedInvoices.map(invoice => ({
      date: invoice.date,
      vendor: invoice.vendor,
      amount: invoice.amount,
      invoice: invoice.invoiceNumber || '',
      notes: invoice.source,
    }));
  }
}
