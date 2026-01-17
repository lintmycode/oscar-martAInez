import fs from 'fs/promises';
import path from 'path';

/**
 * Identify transactions that should be moved to the personal account
 */
export class PersonalExceptionFilter {
  constructor() {
    this.patterns = [];
  }

  /**
   * Load exception patterns from file
   */
  async load(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const lines = content.split('\n');

      this.patterns = lines
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#')) // Skip empty and comments
        .map(pattern => this.patternToRegex(pattern));

      console.log(`Loaded ${this.patterns.length} personal exception patterns from ${path.basename(filePath)}`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('No personal-exceptions.txt found, no personal exceptions applied');
      } else {
        console.warn(`Warning: Could not load personal exceptions: ${error.message}`);
      }
    }
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
   * Check if a transaction should be moved to personal account
   */
  shouldMove(transaction) {
    if (this.patterns.length === 0) {
      return false;
    }

    const description = transaction.rawDescription || transaction.vendor || '';

    for (const pattern of this.patterns) {
      if (pattern.test(description)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Split transactions into personal exceptions and remaining
   */
  split(transactions) {
    if (this.patterns.length === 0) {
      return { personal: [], remaining: transactions };
    }

    const personal = [];
    const remaining = [];

    for (const txn of transactions) {
      if (this.shouldMove(txn)) {
        personal.push(txn);
      } else {
        remaining.push(txn);
      }
    }

    if (personal.length > 0) {
      console.log(`Moved ${personal.length} transactions to personal account (exceptions)`);
    }

    return { personal, remaining };
  }
}
