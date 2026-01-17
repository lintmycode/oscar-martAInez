import fs from 'fs/promises';
import path from 'path';
import pdf from 'pdf-parse';

/**
 * Extract invoice data from PDFs and images
 * Uses sidecar JSON files for caching (e.g., invoice.pdf + invoice.json)
 */
export class InvoiceExtractor {
  constructor(openaiClient, tokenTracker) {
    this.openai = openaiClient;
    this.tokenTracker = tokenTracker;
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
      invoice = this.parseJsonResponse(content, path.basename(filePath));
    } catch (error) {
      console.error(`    Failed to extract: ${error.message}`);
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
      }
    } catch (error) {
      console.log(`Warning: Could not process paper/ directory: ${error.message}`);
    }

    console.log(`\nTotal invoices extracted: ${invoices.length}`);
    return invoices;
  }
}
