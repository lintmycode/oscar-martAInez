import fs from 'fs/promises';
import { detect } from 'jschardet';

/**
 * Auto-detect CSV encoding, delimiter, and parse to array of objects
 */
export class CsvParser {
  /**
   * Detect encoding of a file buffer
   */
  static async detectEncoding(filePath) {
    const buffer = await fs.readFile(filePath);
    const detected = detect(buffer);
    return detected.encoding || 'utf8';
  }

  /**
   * Detect delimiter by analyzing first few lines
   */
  static detectDelimiter(text) {
    const firstLines = text.split('\n').slice(0, 5);
    const delimiters = [';', ',', '\t', '|'];

    const counts = delimiters.map(delim => {
      const count = firstLines[0].split(delim).length;
      // Check consistency across lines
      const consistent = firstLines.every(line => line.split(delim).length === count);
      return { delim, count, consistent };
    });

    const best = counts
      .filter(c => c.consistent && c.count > 1)
      .sort((a, b) => b.count - a.count)[0];

    return best ? best.delim : ';';
  }

  /**
   * Parse CSV text to array of objects
   */
  static parseToObjects(text, delimiter) {
    const lines = text.split('\n').filter(line => line.trim());
    if (lines.length === 0) return [];

    // Find header row (contains "Data" and at least one of: Montante, Débito, Descrição)
    let headerIdx = -1;
    for (let i = 0; i < Math.min(20, lines.length); i++) {
      const line = lines[i].toLowerCase();
      if ((line.includes('data') || line.includes('date')) &&
          (line.includes('montante') || line.includes('débito') || line.includes('descrição'))) {
        headerIdx = i;
        break;
      }
    }

    if (headerIdx === -1) {
      // Fallback to first line
      headerIdx = 0;
    }

    const headers = lines[headerIdx].split(delimiter).map(h => h.trim());
    const rows = [];

    for (let i = headerIdx + 1; i < lines.length; i++) {
      const values = lines[i].split(delimiter);

      // Skip rows that don't match header count
      if (values.length < headers.length - 1) continue;

      const obj = {};
      headers.forEach((header, idx) => {
        obj[header] = values[idx] ? values[idx].trim() : '';
      });

      // Skip rows that are clearly not data (e.g., "Totais")
      const firstValue = values[0] ? values[0].toLowerCase() : '';
      if (firstValue.includes('totais') || firstValue.includes('total')) continue;

      rows.push(obj);
    }

    return rows;
  }

  /**
   * Main entry point: read, detect, and parse CSV file
   */
  static async parse(filePath) {
    try {
      // Detect encoding
      const encoding = await this.detectEncoding(filePath);
      console.log(`  Detected encoding: ${encoding}`);

      // Read with detected encoding (map common encodings)
      const buffer = await fs.readFile(filePath);
      let finalEncoding = encoding;

      // Map jschardet encodings to TextDecoder encodings
      if (encoding.includes('windows') || encoding.includes('1252') || encoding.includes('1251')) {
        finalEncoding = 'windows-1252'; // Common for Portuguese CSVs
      } else if (encoding === 'ascii') {
        finalEncoding = 'utf8';
      }

      const decoder = new TextDecoder(finalEncoding);
      const text = decoder.decode(buffer);

      // Detect delimiter
      const delimiter = this.detectDelimiter(text);
      console.log(`  Detected delimiter: "${delimiter}"`);

      // Parse to objects
      const rows = this.parseToObjects(text, delimiter);
      console.log(`  Parsed ${rows.length} rows`);

      return { rows, encoding, delimiter };
    } catch (error) {
      throw new Error(`Failed to parse CSV ${filePath}: ${error.message}`);
    }
  }

  /**
   * Normalize amount string to float (handles comma/dot decimals)
   */
  static parseAmount(amountStr) {
    if (!amountStr) return 0;

    // Remove currency symbols and whitespace
    let cleaned = amountStr.replace(/[€$\s]/g, '');

    // Detect format: if last comma is after last dot, comma is decimal separator
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');

    if (lastComma > lastDot) {
      // European format: 1.234,56
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      // US format: 1,234.56
      cleaned = cleaned.replace(/,/g, '');
    }

    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
  }

  /**
   * Parse date in various formats to dd/mm/yyyy
   */
  static parseDate(dateStr) {
    if (!dateStr) return '';

    // Try dd-mm-yyyy or dd/mm/yyyy
    const dmyMatch = dateStr.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
    if (dmyMatch) {
      const [, day, month, year] = dmyMatch;
      return `${day.padStart(2, '0')}/${month.padStart(2, '0')}/${year}`;
    }

    // Try yyyy-mm-dd
    const ymdMatch = dateStr.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (ymdMatch) {
      const [, year, month, day] = ymdMatch;
      return `${day.padStart(2, '0')}/${month.padStart(2, '0')}/${year}`;
    }

    return dateStr; // Return as-is if can't parse
  }

  /**
   * Extract year and month from date string
   */
  static getYearMonth(dateStr) {
    const normalized = this.parseDate(dateStr);
    const match = normalized.match(/\d{2}\/(\d{2})\/(\d{4})/);
    if (match) {
      return { year: parseInt(match[2]), month: parseInt(match[1]) };
    }
    return null;
  }
}
