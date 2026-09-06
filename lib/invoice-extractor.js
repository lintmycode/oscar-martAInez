import fs from 'fs/promises';
import path from 'path';
import pdf from 'pdf-parse';
import { RetryHelper } from './retry-helper.js';

/**
 * Extract invoice data from PDFs and images
 * Uses sidecar JSON files for caching (e.g., invoice.pdf + invoice.json)
 */
// A null extraction has two very different causes: the model read the
// document and genuinely found no usable date, or the call never got a
// useful answer at all (no credits, rate limit exhausted, network down,
// bad key). Callers that re-poll the same source - poll-inbox.js - must
// retry the second kind rather than filing the attachment for manual
// review; treating an outage as "unreadable" permanently buries invoices
// in needs-review and re-downloads them on every run.
function isInfraFailure(error) {
  if (error.status === 429 || error.status === 401 || error.status >= 500) return true;
  // RetryHelper collapses an exhausted 429 backoff into a plain Error, so
  // the status code is gone by the time it reaches us - match its wording.
  if (/Rate limit retry failed|no credits remaining|quota/i.test(error.message || '')) return true;
  // Undici/Node network-layer failures surface as a cause chain, not a status.
  return /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed/i.test(error.message || '');
}

export class InvoiceExtractor {
  constructor(openaiClient, tokenTracker) {
    this.openai = openaiClient;
    this.tokenTracker = tokenTracker;
    // Set on every extract call; read by callers immediately after a null
    // return to tell the two failure kinds above apart.
    this.lastFailureWasInfra = false;
  }

  /**
   * Get sidecar JSON path for an invoice file
   * e.g., 5372983288.pdf -> 5372983288.json
   */
  getSidecarPath(filePath) {
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    return path.join(dir, `${base}.json`);
  }

  /**
   * Load cached invoice data from sidecar JSON
   */
  async loadSidecar(filePath) {
    const sidecarPath = this.getSidecarPath(filePath);
    try {
      const data = await fs.readFile(sidecarPath, 'utf8');
      const parsed = JSON.parse(data);
      console.log(`  Using cached data from ${path.basename(sidecarPath)}`);
      return parsed;
    } catch (error) {
      return null; // No cache
    }
  }

  /**
   * Save invoice data to sidecar JSON
   */
  async saveSidecar(filePath, invoiceData) {
    const sidecarPath = this.getSidecarPath(filePath);
    await fs.writeFile(sidecarPath, JSON.stringify(invoiceData, null, 2));
    console.log(`  Saved to ${path.basename(sidecarPath)}`);
  }

  /**
   * Extract text from PDF (local, no API)
   */
  async extractPdfText(filePath) {
    const buffer = await fs.readFile(filePath);
    const data = await pdf(buffer);
    return data.text;
  }

  /**
   * Extract invoice data from PDF using text extraction + OpenAI
   */
  async extractFromPdf(filePath) {
    console.log(`  Processing PDF: ${path.basename(filePath)}`);

    // Check for cached data
    const cached = await this.loadSidecar(filePath);
    if (cached) {
      return cached;
    }

    // Try local text extraction first
    const text = await this.extractPdfText(filePath);

    let invoice;
    if (text && text.length > 50) {
      // Use OpenAI to parse structured data from text
      invoice = await this.parseInvoiceText(text, path.basename(filePath));
    } else {
      // PDF is likely image-based, need vision API
      console.log(`    PDF appears to be image-based, using vision API`);
      invoice = await this.extractFromImage(filePath, true);
    }

    // Save to sidecar
    if (invoice) {
      await this.saveSidecar(filePath, invoice);
    }

    return invoice;
  }

  /**
   * Extract invoice data from image using OpenAI Vision
   */
  async extractFromImage(filePath, isPdf = false) {
    console.log(`  Processing image: ${path.basename(filePath)}`);
    this.lastFailureWasInfra = false;

    // Check for cached data
    const cached = await this.loadSidecar(filePath);
    if (cached) {
      return cached;
    }

    const buffer = await fs.readFile(filePath);
    const base64 = buffer.toString('base64');

    // Determine mime type
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.pdf': 'application/pdf',
    };
    const mimeType = mimeTypes[ext] || 'image/jpeg';

    const prompt = this.getExtractionPrompt();

    let invoice;
    try {
      // Retry with exponential backoff on rate limits
      const response = await RetryHelper.retry(async () => {
        return await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          max_tokens: 1000,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${mimeType};base64,${base64}`,
                  },
                },
              ],
            },
          ],
        });
      }, {
        maxRetries: 5,
        initialDelay: 500,
        maxDelay: 10000,
      });

      this.tokenTracker.add('vision_extraction', response.usage);

      const content = response.choices[0].message.content;
      invoice = this.parseJsonResponse(content, path.basename(filePath));
    } catch (error) {
      console.error(`    Failed to extract: ${error.message}`);
      this.lastFailureWasInfra = isInfraFailure(error);
      return null;
    }

    // Save to sidecar
    if (invoice) {
      await this.saveSidecar(filePath, invoice);
    }

    return invoice;
  }

  /**
   * Parse invoice text using OpenAI (text-only, cheaper)
   */
  async parseInvoiceText(text, filename) {
    this.lastFailureWasInfra = false;
    const prompt = this.getExtractionPrompt();
    const fullPrompt = `${prompt}\n\nInvoice text:\n${text.substring(0, 4000)}`;

    try {
      // Retry with exponential backoff on rate limits
      const response = await RetryHelper.retry(async () => {
        return await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          max_tokens: 500,
          messages: [
            { role: 'user', content: fullPrompt },
          ],
        });
      }, {
        maxRetries: 5,
        initialDelay: 500,
        maxDelay: 10000,
      });

      this.tokenTracker.add('text_extraction', response.usage);

      const content = response.choices[0].message.content;
      return this.parseJsonResponse(content, filename);
    } catch (error) {
      console.error(`    Failed to parse text: ${error.message}`);
      this.lastFailureWasInfra = isInfraFailure(error);
      return null;
    }
  }

  /**
   * Prompt for invoice extraction (same for UI and API)
   */
  getExtractionPrompt() {
    return `Extract invoice data and return ONLY valid JSON (no markdown, no explanation).

Required fields:
- vendor: supplier/company name
- invoiceNumber: invoice/receipt number (string)
- date: invoice date in dd/mm/yyyy format (use billing period/service date if available, NOT issue date)
- amount: total amount as number (no currency symbol)
- currency: ISO code or symbol (e.g., EUR, USD, €, $)

IMPORTANT for date field:
- For subscription/utility invoices (DigitalOcean, Google, utilities, etc.), use the BILLING PERIOD or SERVICE DATE
- Examples: "Invoice for October 2025" → use October date, NOT the issue date
- NEVER use a "renews on" / "renova a" / "next billing date" value - that is a FUTURE date for the
  NEXT charge, not this one. Always use the date this specific invoice/receipt was issued/charged.
- If only issue date exists, use that
- Format: dd/mm/yyyy (day/month/year)

If a field is not found, use null.

Example:
{"vendor":"ACME Corp","invoiceNumber":"INV-123","date":"15/10/2025","amount":39.99,"currency":"EUR"}`;
  }

  /**
   * Parse JSON from OpenAI response (handles markdown wrapping)
   */
  parseJsonResponse(content, filename) {
    try {
      // Remove markdown code blocks if present
      const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      const currency = this.normalizeCurrency(parsed.currency);

      return {
        vendor: parsed.vendor || 'Unknown',
        invoiceNumber: parsed.invoiceNumber || '',
        date: parsed.date || '',
        amount: parseFloat(parsed.amount) || 0,
        currency: currency || null,
        source: filename,
      };
    } catch (error) {
      console.error(`    Failed to parse JSON: ${error.message}`);
      return {
        vendor: 'Unknown',
        invoiceNumber: '',
        date: '',
        amount: 0,
        currency: null,
        source: filename,
      };
    }
  }

  /**
   * Normalize currency to ISO code when possible
   */
  normalizeCurrency(value) {
    if (!value) return '';
    const raw = String(value).trim().toUpperCase();
    if (raw === '$' || raw === 'US$' || raw === 'USD' || raw.includes('USD')) {
      return 'USD';
    }
    if (raw === '€' || raw === 'EUR' || raw.includes('EUR') || raw.includes('EURO')) {
      return 'EUR';
    }
    return raw;
  }

  /**
   * Extract from all invoices in directories
   */
  async extractAll(paperDir, digitalDir) {
    const invoices = [];

    // Process digital (PDFs)
    try {
      const digitalFiles = await fs.readdir(digitalDir);
      const pdfFiles = digitalFiles.filter(f => f.toLowerCase().endsWith('.pdf'));

      console.log(`\nProcessing ${pdfFiles.length} PDF invoices...`);

      for (const file of pdfFiles) {
        const filePath = path.join(digitalDir, file);
        const invoice = await this.extractFromPdf(filePath);
        if (invoice) {
          invoices.push(invoice);
        }
      }
    } catch (error) {
      console.log(`Warning: Could not process digital/ directory: ${error.message}`);
    }

    // Process paper (images)
    try {
      const paperFiles = await fs.readdir(paperDir);
      const imageFiles = paperFiles.filter(f =>
        /\.(jpg|jpeg|png)$/i.test(f)
      );

      console.log(`\nProcessing ${imageFiles.length} paper invoices...`);

      for (const file of imageFiles) {
        const filePath = path.join(paperDir, file);
        const invoice = await this.extractFromImage(filePath);
        if (invoice) {
          invoices.push(invoice);
        }

        // Small delay between images to avoid rate limits (only if using OpenAI)
        if (this.openai) {
          await RetryHelper.throttle(300);
        }
      }
    } catch (error) {
      console.log(`Warning: Could not process paper/ directory: ${error.message}`);
    }

    console.log(`\nTotal invoices extracted: ${invoices.length}`);
    return invoices;
  }
}
