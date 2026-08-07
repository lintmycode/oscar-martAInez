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
        // Scale relative to the tolerance actually in effect, so this never goes
        // negative even for the wider grouped tolerance (was a fixed *20 penalty,
        // which could swing past -100 once grouped tolerance grew to 5x base)
        parts.amount = 40 * (1 - amountDiff / tolerance);
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
      // For grouped transactions with a defined invoice-vendor pattern, only an
      // invoice matching that pattern is eligible - this bucket exists for one
      // specific recurring vendor (e.g. Via Verde). Without this gate, an unrelated
      // invoice with a coincidental exact amount/date can outscore the real one,
      // since amount+date alone (up to 70pts) already clears the grouped threshold.
      if (transaction.invoiceMatchPattern.test(invoice.vendor)) {
        parts.vendor = 20; // Strong match via pattern
        details.vendorPatternMatch = true;
      } else {
        return { score: -1, parts, details };
      }
    } else {
      // Regular fuzzy matching
      const similarity = stringSimilarity.compareTwoStrings(
        this.normalizeVendor(invoice.vendor),
        this.normalizeVendor(this.getTransactionMatchVendor(transaction))
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

  getTransactionMatchVendor(transaction) {
    return transaction.matchVendor || transaction.vendor || '';
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
   * Format the score breakdown for a match's console log line
   */
  formatDetailSummary(details = {}) {
    const detailParts = [];
    if (details.amountDiff !== null && details.amountDiff !== undefined) {
      detailParts.push(`amount diff: ${details.amountDiff.toFixed(2)}€`);
    }
    if (details.daysDiff !== null && details.daysDiff !== undefined) {
      detailParts.push(`date diff: ${Math.round(details.daysDiff)}d`);
    }
    if (details.vendorPatternMatch) {
      detailParts.push('vendor match: pattern');
    } else if (details.vendorSimilarity !== null && details.vendorSimilarity !== undefined) {
      detailParts.push(`vendor similarity: ${details.vendorSimilarity.toFixed(2)}`);
    }
    return detailParts.length > 0 ? ` | ${detailParts.join(' | ')}` : '';
  }

  /**
   * Match all invoices to transactions.
   *
   * Scores every viable (invoice, transaction) pair up front and assigns
   * globally strongest-first, rather than looping invoice-by-invoice and
   * greedily grabbing whatever's available at that point. The per-invoice
   * loop order is arbitrary (directory listing order), so a weak coincidental
   * match processed early could otherwise steal a transaction that a much
   * stronger match - for a different invoice, processed later - actually needed.
   */
  matchAll(invoices, transactions) {
    console.log(`\nMatching ${invoices.length} invoices to ${transactions.length} transactions...`);

    // Build every candidate pair that clears its minimum score threshold
    const candidates = [];
    for (const invoice of invoices) {
      for (const transaction of transactions) {
        const { score, parts, details } = this.calculateScore(invoice, transaction);
        // Grouped transactions get a lower threshold (pattern match + amount is often enough)
        const minScore = transaction.isGrouped ? 30 : 40;
        if (score >= minScore) {
          candidates.push({ invoice, transaction, score, parts, details });
        }
      }
    }

    // Strongest matches claim their transaction first, regardless of invoice order
    candidates.sort((a, b) => b.score - a.score);

    const matched = [];
    const matchedInvoices = new Set();
    const usedTransactionIds = new Set();

    for (const candidate of candidates) {
      if (matchedInvoices.has(candidate.invoice)) continue;
      const txnId = this.getTxnId(candidate.transaction);
      if (usedTransactionIds.has(txnId)) continue;

      matched.push({
        invoice: candidate.invoice,
        transaction: candidate.transaction,
        score: candidate.score,
      });
      matchedInvoices.add(candidate.invoice);
      usedTransactionIds.add(txnId);

      console.log(
        `  ✓ Matched: ${candidate.invoice.vendor} (${candidate.invoice.amount}€) -> ` +
        `${candidate.transaction.vendor} (score: ${candidate.score.toFixed(1)}${this.formatDetailSummary(candidate.details)})`
      );
    }

    const unmatched = invoices.filter(invoice => !matchedInvoices.has(invoice));
    unmatched.forEach(invoice => {
      console.log(`  ✗ No match: ${invoice.vendor} (${invoice.amount}€)`);
    });

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
      tipo: txn.type === 'incoming' ? 'Entrada' : 'Saída',
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
