import fs from 'fs/promises';
import path from 'path';

/**
 * Filter to exclude transactions based on patterns
 */
export class ExclusionFilter {
  constructor() {
    this.patterns = [];
  }

  /**
   * Load exclusion patterns from file
   */
  async load(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const lines = content.split('\n');

      this.patterns = lines
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#')) // Skip empty and comments
        .map(pattern => this.patternToRegex(pattern));

      console.log(`Loaded ${this.patterns.length} exclusion patterns from ${path.basename(filePath)}`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log(`No ${path.basename(filePath)} found, nothing excluded`);
      } else {
        console.warn(`Warning: Could not load exclusions: ${error.message}`);
      }
    }
  }

  /**
   * Convert wildcard pattern to regex
   * Example: "TRF RV * N*" -> /^TRF RV .* N.*$/i
   */
  patternToRegex(pattern) {
    // Escape special regex characters except *
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // Escape special chars
      .replace(/\*/g, '.*');                    // Convert * to .*

    return new RegExp(`^${escaped}$`, 'i'); // Case-insensitive, full match
  }

  /**
   * Check if a transaction should be excluded
   */
  shouldExclude(transaction) {
    if (this.patterns.length === 0) {
      return false; // No exclusions loaded
    }

    return this.matches(transaction.rawDescription || transaction.vendor || '');
  }

  /**
   * Check if any of the given strings matches an exclusion pattern
   */
  matches(...texts) {
    return texts.some(text => text && this.patterns.some(pattern => pattern.test(text)));
  }

  /**
   * Filter array of transactions
   */
  filter(transactions) {
    if (this.patterns.length === 0) {
      return transactions; // No filtering
    }

    const original = transactions.length;
    const filtered = transactions.filter(txn => !this.shouldExclude(txn));
    const excluded = original - filtered.length;

    if (excluded > 0) {
      console.log(`Excluded ${excluded} transactions based on patterns`);
    }

    return filtered;
  }
}
