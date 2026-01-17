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
    const parts = {
      amount: 0,
      date: 0,
      vendor: 0,
    };
    const details = {
      amountDiff: null,
      amountTolerance: null,
      daysDiff: null,
      vendorSimilarity: null,
      vendorPatternMatch: false,
    };

    // 1. Amount match (most important)
    const invoiceAmountEur = this.getInvoiceAmountEur(invoice);
    const amountDiff = Math.abs(invoiceAmountEur - transaction.amount);
    details.amountDiff = amountDiff;

    // For grouped transactions, use higher tolerance (invoices may include extra fees)
    const tolerance = transaction.isGrouped
      ? CONFIG.matching.amountTolerance * 5  // €2.50 for grouped
      : CONFIG.matching.amountTolerance;     // €0.50 for regular
    details.amountTolerance = tolerance;

    if (amountDiff <= tolerance) {
      if (amountDiff === 0) {
        parts.amount = 50; // Exact match
      } else {
        parts.amount = 40 - (amountDiff * 20); // Close match
      }
    }
    score += parts.amount;

    // 2. Date proximity
    const invoiceDate = this.parseDate(invoice.date);
    const transactionDate = this.parseDate(transaction.date);

    if (invoiceDate && transactionDate) {
      const daysDiff = Math.abs(
        (invoiceDate - transactionDate) / (1000 * 60 * 60 * 24)
      );
      details.daysDiff = daysDiff;

      if (daysDiff <= CONFIG.matching.dateProximityDays) {
        parts.date = 30 - (daysDiff * 3);
      }
    }
    score += parts.date;

    // 3. Vendor similarity (fuzzy match or pattern match for grouped transactions)
    if (transaction.invoiceMatchPattern && typeof transaction.invoiceMatchPattern.test === 'function') {
      // For grouped transactions, use the pattern from grouping rule
      if (transaction.invoiceMatchPattern.test(invoice.vendor)) {
        parts.vendor = 20; // Strong match via pattern
        details.vendorPatternMatch = true;
      }
    } else {
      // Regular fuzzy matching
      const similarity = stringSimilarity.compareTwoStrings(
        this.normalizeVendor(invoice.vendor),
        this.normalizeVendor(transaction.vendor)
      );
      details.vendorSimilarity = similarity;

      if (similarity >= CONFIG.matching.vendorSimilarityThreshold) {
        parts.vendor = similarity * 20;
      }
    }
    score += parts.vendor;

    return { score, parts, details };
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
   * Convert invoice amount to EUR when currency is known
   */
  getInvoiceAmountEur(invoice) {
    const amount = Number(invoice.amount) || 0;
    const currency = (invoice.currency || '').toString().trim().toUpperCase();

    if (!currency || currency === 'EUR' || currency === '€') {
      return amount;
    }

    if (currency === 'USD' || currency === 'US$' || currency === '$') {
      return amount * CONFIG.usd2eur;
    }

    return amount;
  }

  /**
   * Find best match for an invoice
   */
  findBestMatch(invoice, transactions) {
    const candidates = transactions.map(txn => ({
      transaction: txn,
      ...this.calculateScore(invoice, txn),
    }));

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    const best = candidates[0];

    // Grouped transactions get lower threshold (pattern match + amount is often enough)
    const minScore = best && best.transaction.isGrouped ? 30 : 40;

    // If score is too low, no match
    if (!best || best.score < minScore) {
      return null;
    }

    // Check for ambiguity (multiple similar scores)
    const secondBest = candidates[1];
    if (secondBest && Math.abs(best.score - secondBest.score) < 10) {
      // If best is grouped with pattern match, prefer it (not ambiguous)
      if (best.transaction.isGrouped && best.transaction.invoiceMatchPattern) {
        // Continue to use best match
      } else {
        return {
          match: null,
          ambiguous: true,
          candidates: candidates.slice(0, 3),
        };
      }
    }

    return {
      match: best.transaction,
      score: best.score,
      parts: best.parts,
      details: best.details,
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
        const details = result.details || {};
        const detailParts = [];
        if (details.amountDiff !== null) {
          detailParts.push(`amount diff: ${details.amountDiff.toFixed(2)}€`);
        }
        if (details.daysDiff !== null) {
          detailParts.push(`date diff: ${Math.round(details.daysDiff)}d`);
        }
        if (details.vendorPatternMatch) {
          detailParts.push('vendor match: pattern');
        } else if (details.vendorSimilarity !== null) {
          detailParts.push(`vendor similarity: ${details.vendorSimilarity.toFixed(2)}`);
        }
        const detailSummary = detailParts.length > 0
          ? ` | ${detailParts.join(' | ')}`
          : '';
        console.log(
          `  ✓ Matched: ${invoice.vendor} (${invoice.amount}€) -> ` +
          `${result.match.vendor} (score: ${result.score.toFixed(1)}${detailSummary})`
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
      file: '',
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
        result[index].file = match.invoice.source || '';
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
      amount: this.getInvoiceAmountEur(invoice),
      invoice: invoice.invoiceNumber || '',
      file: invoice.source || '',
      notes: invoice.source,
    }));
  }
}
