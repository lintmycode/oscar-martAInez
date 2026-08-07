import fs from 'fs/promises';
import path from 'path';

/**
 * Attach an explanatory note to transactions that will never have an invoice
 * (bank errors, reversed/returned transfers, etc.) - keeps them visible in
 * the company sheet with context instead of looking like an unexplained gap.
 */
export class TransactionNotes {
  constructor() {
    this.rules = [];
  }

  /**
   * Load note rules from file
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

      console.log(`Loaded ${this.rules.length} transaction note rules from ${path.basename(filePath)}`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('No transaction-notes.txt found, no notes applied');
      } else {
        console.warn(`Warning: Could not load transaction notes: ${error.message}`);
      }
    }
  }

  /**
   * Parse a note rule line
   * Format: PATTERN → NOTE
   */
  parseRule(line) {
    const parts = line.split('→').map(p => p.trim());

    if (parts.length < 2) {
      console.warn(`Invalid transaction note rule (needs PATTERN → NOTE): ${line}`);
      return null;
    }

    return {
      pattern: this.patternToRegex(parts[0]),
      note: parts[1],
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
   * Get the note for a transaction description, if any rule matches
   */
  getNote(description) {
    if (!description) return null;
    for (const rule of this.rules) {
      if (rule.pattern.test(description)) {
        return rule.note;
      }
    }
    return null;
  }
}
