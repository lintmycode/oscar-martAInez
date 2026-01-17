import fs from 'fs/promises';
import path from 'path';
import pdf from 'pdf-parse';
import crypto from 'crypto';

/**
 * Extract invoice data from PDFs and images
 */
export class InvoiceExtractor {
  constructor(openaiClient, tokenTracker) {
    this.openai = openaiClient;
    this.tokenTracker = tokenTracker;
    this.cache = new Map();
  }

  /**
   * Load cache from disk
   */
  async loadCache(cacheFile) {
    try {
      const data = await fs.readFile(cacheFile, 'utf8');
      const parsed = JSON.parse(data);
      this.cache = new Map(Object.entries(parsed));
      console.log(`Loaded ${this.cache.size} cached invoices`);
    } catch (error) {
      console.log('No cache file found, starting fresh');
    }
  }

  /**
   * Save cache to disk
   */
  async saveCache(cacheFile) {
    const obj = Object.fromEntries(this.cache);
    await fs.writeFile(cacheFile, JSON.stringify(obj, null, 2));
    console.log(`Saved ${this.cache.size} invoices to cache`);
  }

  /**
   * Compute file hash for cache key
   */
  async getFileHash(filePath) {
    const buffer = await fs.readFile(filePath);
    return crypto.createHash('md5').update(buffer).digest('hex');
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

    // Try local text extraction first
    const text = await this.extractPdfText(filePath);

    if (text && text.length > 50) {
      // Use OpenAI to parse structured data from text
      return await this.parseInvoiceText(text, path.basename(filePath));
    } else {
      // PDF is likely image-based, need vision API
      console.log(`    PDF appears to be image-based, using vision API`);
      return await this.extractFromImage(filePath, true);
    }
  }

  /**
   * Extract invoice data from image using OpenAI Vision
   */
  async extractFromImage(filePath, isPdf = false) {
    console.log(`  Processing image: ${path.basename(filePath)}`);

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

    try {
      const response = await this.openai.chat.completions.create({
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

      this.tokenTracker.add('vision_extraction', response.usage);

      const content = response.choices[0].message.content;
      return this.parseJsonResponse(content, path.basename(filePath));
    } catch (error) {
      console.error(`    Failed to extract: ${error.message}`);
      return null;
    }
  }

  /**
   * Parse invoice text using OpenAI (text-only, cheaper)
   */
  async parseInvoiceText(text, filename) {
    const prompt = this.getExtractionPrompt();
    const fullPrompt = `${prompt}\n\nInvoice text:\n${text.substring(0, 4000)}`;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 500,
        messages: [
          { role: 'user', content: fullPrompt },
        ],
      });

      this.tokenTracker.add('text_extraction', response.usage);

      const content = response.choices[0].message.content;
      return this.parseJsonResponse(content, filename);
    } catch (error) {
      console.error(`    Failed to parse text: ${error.message}`);
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
- date: invoice date in dd/mm/yyyy format
- amount: total amount as number (no currency symbol)

If a field is not found, use null.

Example:
{"vendor":"ACME Corp","invoiceNumber":"INV-123","date":"15/10/2025","amount":39.99}`;
  }

  /**
   * Parse JSON from OpenAI response (handles markdown wrapping)
   */
  parseJsonResponse(content, filename) {
    try {
      // Remove markdown code blocks if present
      const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);

      return {
        vendor: parsed.vendor || 'Unknown',
        invoiceNumber: parsed.invoiceNumber || '',
        date: parsed.date || '',
        amount: parseFloat(parsed.amount) || 0,
        source: filename,
      };
    } catch (error) {
      console.error(`    Failed to parse JSON: ${error.message}`);
      return {
        vendor: 'Unknown',
        invoiceNumber: '',
        date: '',
        amount: 0,
        source: filename,
      };
    }
  }

  /**
   * Extract from all invoices in directories
   */
  async extractAll(paperDir, digitalDir, cacheFile) {
    await this.loadCache(cacheFile);

    const invoices = [];

    // Process digital (PDFs)
    try {
      const digitalFiles = await fs.readdir(digitalDir);
      const pdfFiles = digitalFiles.filter(f => f.toLowerCase().endsWith('.pdf'));

      console.log(`\nProcessing ${pdfFiles.length} PDF invoices...`);

      for (const file of pdfFiles) {
        const filePath = path.join(digitalDir, file);
        const hash = await this.getFileHash(filePath);

        // Check cache
        if (this.cache.has(hash)) {
          console.log(`  Using cached data for ${file}`);
          invoices.push(this.cache.get(hash));
          continue;
        }

        const invoice = await this.extractFromPdf(filePath);
        if (invoice) {
          this.cache.set(hash, invoice);
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
        const hash = await this.getFileHash(filePath);

        // Check cache
        if (this.cache.has(hash)) {
          console.log(`  Using cached data for ${file}`);
          invoices.push(this.cache.get(hash));
          continue;
        }

        const invoice = await this.extractFromImage(filePath);
        if (invoice) {
          this.cache.set(hash, invoice);
          invoices.push(invoice);
        }
      }
    } catch (error) {
      console.log(`Warning: Could not process paper/ directory: ${error.message}`);
    }

    await this.saveCache(cacheFile);

    console.log(`\nTotal invoices extracted: ${invoices.length}`);
    return invoices;
  }
}
