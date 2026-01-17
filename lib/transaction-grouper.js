import fs from 'fs/promises';
import path from 'path';

/**
 * Group related transactions into single entries
 * Example: Multiple toll charges → "Via Verde Tolls"
 */
export class TransactionGrouper {
  constructor() {
    this.rules = [];
  }

  /**
   * Load grouping rules from file
   */
  async load(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const lines = content.split('\n');

      this.rules = lines
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(line => this.parseRule(line))
        .filter(rule => rule !== null);

      console.log(`Loaded ${this.rules.length} grouping rules from ${path.basename(filePath)}`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('No grouping-rules.txt found, no transaction grouping');
      } else {
        console.warn(`Warning: Could not load grouping rules: ${error.message}`);
      }
    }
  }

  /**
   * Parse a grouping rule line
   * Format: PATTERN → DISPLAY_NAME → INVOICE_VENDOR_MATCH
   */
  parseRule(line) {
    const parts = line.split('→').map(p => p.trim());

    if (parts.length < 2) {
      console.warn(`Invalid grouping rule (needs at least 2 parts): ${line}`);
      return null;
    }

    const pattern = parts[0];
    const displayName = parts[1];
    const invoiceMatch = parts[2] || null;

    return {
      pattern: this.patternToRegex(pattern),
      patternStr: pattern,
      displayName: displayName,
      invoiceMatch: invoiceMatch ? this.patternToRegex(invoiceMatch) : null,
    };
  }

  /**
   * Convert wildcard pattern to regex
   */
  patternToRegex(pattern) {
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i');
  }

  /**
   * Find which rule matches a transaction
   */
  findMatchingRule(transaction) {
    const description = transaction.rawDescription || transaction.vendor || '';

    for (const rule of this.rules) {
      if (rule.pattern.test(description)) {
        return rule;
      }
    }

    return null;
  }

  /**
   * Group transactions based on rules
   */
  group(transactions) {
    if (this.rules.length === 0) {
      return transactions; // No grouping
    }

    const grouped = [];
    const toGroup = new Map(); // ruleIndex -> [transactions]
    const ungrouped = [];

    // Categorize transactions
    for (const txn of transactions) {
      const rule = this.findMatchingRule(txn);

      if (rule) {
        const key = rule.displayName;
        if (!toGroup.has(key)) {
          toGroup.set(key, { rule, transactions: [] });
        }
        toGroup.get(key).transactions.push(txn);
      } else {
        ungrouped.push(txn);
      }
    }

    // Create grouped transactions
    for (const [displayName, { rule, transactions: txns }] of toGroup.entries()) {
      if (txns.length === 1) {
        // Only one transaction, don't group
        ungrouped.push(txns[0]);
      } else {
        // Multiple transactions, create grouped entry
        const totalAmount = txns.reduce((sum, t) => sum + t.amount, 0);
        const dates = txns.map(t => t.date).sort();
        const firstDate = dates[0];
        const sources = [...new Set(txns.map(t => t.source))].join(', ');

        const groupedTxn = {
          date: firstDate,
          vendor: displayName,
          amount: totalAmount,
          type: txns[0].type, // Assume all same type
          rawDescription: `${txns.length} transactions: ${rule.patternStr}`,
          source: sources,
          isGrouped: true,
          groupedCount: txns.length,
          groupedItems: txns,
          invoiceMatchPattern: rule.invoiceMatch,
        };

        grouped.push(groupedTxn);
      }
    }

    const result = [...ungrouped, ...grouped];

    // Sort by date
    result.sort((a, b) => {
      const [dayA, monthA, yearA] = a.date.split('/').map(Number);
      const [dayB, monthB, yearB] = b.date.split('/').map(Number);
      const dateA = new Date(yearA, monthA - 1, dayA);
      const dateB = new Date(yearB, monthB - 1, dayB);
      return dateA - dateB;
    });

    const groupedCount = grouped.reduce((sum, g) => sum + (g.groupedCount || 0), 0);
    if (groupedCount > 0) {
      console.log(`Grouped ${groupedCount} transactions into ${grouped.length} entries`);
    }

    return result;
  }
}
