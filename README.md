# oscar-martAInez

AI-powered monthly accounting automation. Matches bank/credit card transactions to invoice documents using OpenAI.

## Features

- **Smart CSV parsing**: Auto-detects encoding, delimiter, and column structure
- **Invoice extraction**: Uses OpenAI Vision API for PDFs and images
- **Intelligent matching**: Scores transactions vs invoices by amount, date, vendor
- **Transaction filtering**: Exclude specific patterns and route personal expenses
- **Transaction grouping**: Automatically group related transactions (e.g., toll charges)
- **Cost control**: Built-in token tracking with hard budget limits
- **Caching**: Never processes the same invoice twice
- **Dual output**: XLSX spreadsheet + debug CSV files with invoice file attachments
- **Export bundle**: Package inputs and outputs for accountant delivery

## Project Structure

```
oscar-martAInez/
├── index.js                    # Main CLI
├── config.js                   # Settings & budget limits
├── create-month.js             # Create month folder structure
├── export-bundle.js            # Package files for accountant
├── test-local.js               # Test CSV parsing (no API)
├── exclusions.txt              # Transactions to exclude entirely
├── ignore-words.txt            # Vendor name cleanup patterns
├── personal-exceptions.txt     # Route to personal account
├── grouping-rules.txt          # Auto-group related transactions
├── lib/                        # Core modules
│   ├── csv-parser.js
│   ├── transaction-extractor.js
│   ├── invoice-extractor.js
│   ├── matcher.js
│   ├── token-tracker.js
│   ├── xlsx-generator.js
│   ├── personal-exception-filter.js
│   ├── exclusion-filter.js
│   └── transaction-grouper.js
│
└── data/                       # Monthly data (git-ignored)
    └── YYYY-MM/                # One folder per month (e.g., 2025-10)
        ├── params.yml          # Month config (optional, can use CLI args)
        ├── inputs/
        │   ├── extracto_*.csv  # Bank/CC statements
        │   ├── paper/          # Paper invoice photos
        │   └── digital/        # PDF invoices
        ├── out/                # Generated outputs
        │   ├── YYYY-MM.xlsx    # Main spreadsheet
        │   ├── *.csv           # Debug CSVs
        │   └── cache.json      # Invoice cache
        └── <company>-export-YYYY-MM/  # Export bundle (created by export-bundle.js)
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure OpenAI API key

Get your API key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys)

```bash
cp .env.example .env
# Edit .env and add your key:
# OPENAI_API_KEY=sk-proj-...
```

### 3. Prepare monthly data

Create a directory for each month:

```
data/
└── 2025-10/                    # October 2025 example
    ├── params.yml              # Optional: year: 2025, month: 10
    └── inputs/
        ├── extracto_cc_oct.csv     # Credit card statement(s)
        ├── extracto_ordem_oct.csv  # Bank account statement
        ├── paper/                  # Paper invoice photos
        │   ├── IMG_001.jpg
        │   └── IMG_002.png
        └── digital/                # PDF invoices
            └── invoice_123.pdf
```

## Usage

### Test CSV parsing (no API cost)

```bash
node test-local.js --y=2025 --m=10
```

### Run full processing

```bash
node index.js --y=2025 --m=10
# or shorthand:
node index.js --year=2025 --month=10
```

### Export bundle for accountant

```bash
node export-bundle.js --y=2025 --m=10
```

Creates `<data-root>/YYYY-MM/<company>-export-YYYY-MM/` with all input files (keeping `digital/` and `paper/` structure), excluding JSON caches, plus the month XLSX renamed to `<company>-YYYY-MM.xlsx`.

### Using an external data directory

By default all month data lives in `./data/` (relative to the project directory). You can point any command at an external path using `--data-root` or the `OSCAR_DATA_ROOT` environment variable. Resolution order:

1. `--data-root=<path>` CLI flag
2. `OSCAR_DATA_ROOT` environment variable
3. `./data` (default — existing behavior unchanged)

```bash
# Via flag
node index.js --y=2025 --m=10 --data-root=/mnt/echo-ops/tmp/data
node create-month.js --y=2025 --m=10 --data-root=/mnt/echo-ops/tmp/data
node export-bundle.js --y=2025 --m=10 --data-root=/mnt/echo-ops/tmp/data
node test-local.js --y=2025 --m=10 --data-root=/mnt/echo-ops/tmp/data

# Via env var (applies to all commands in the session)
export OSCAR_DATA_ROOT=/mnt/echo-ops/tmp/data
node index.js --y=2025 --m=10
```

Configuration files (`exclusions.txt`, `personal-exceptions.txt`, `ignore-words.txt`, `grouping-rules.txt`) always stay in the project root — they are code config, not month data.

### Transaction filtering and routing

You can adjust matching and routing using these files in the project root:

- **`ignore-words.txt`** - Words removed from vendor names for matching only (does not change the XLS output)
- **`exclusions.txt`** - Transactions to exclude entirely (matched against raw description with wildcard support)
- **`personal-exceptions.txt`** - Transactions that should route to the personal account (e.g., `LEVANTAMENTO*`, `*DESPESAS*`)
- **`grouping-rules.txt`** - Auto-group related transactions into single rows (e.g., toll charges)

### Create new month structure

```bash
node create-month.js --y=2025 --m=10
```

Creates `data/YYYY-MM/inputs/{paper,digital}`, `data/YYYY-MM/out`, and a starter `params.yml` if missing.

### Help

```bash
node index.js --help
```

## Output

The tool generates files in `data/YYYY-MM/out/`:

- **YYYY-MM.xlsx** - Excel workbook with 2 sheets:
  - **company account**: All company transactions with matched invoices
  - **personal account**: Personal expenses and unmatched invoices (with TOTAL row)

- **company-account.csv** - Debug CSV export
- **personal-account.csv** - Debug CSV export
- **cache.json** - Cached invoice extractions

### Column structure (both sheets)

| Data       | Fornecedor    | Valor  | Factura    | Ficheiro             | Observações              |
|------------|---------------|--------|------------|----------------------|--------------------------|
| 15/10/2025 | Amazon        | 57.81  | INV-12345  | invoice_123.pdf      | Match score: 87.3        |
| 20/10/2025 | Digital Ocean | 6.98   |            |                      |                          |

- Yellow highlighting for rows missing invoices (company sheet)
- **Ficheiro** column contains clickable links to invoice files
- TOTAL row summing Valor (personal sheet only)
- Bold headers, frozen header row

## How it works

### 1. CSV Processing (local, no API cost)

- Auto-detects encoding (UTF-8, ISO-8859-1, Windows-1252)
- Auto-detects delimiter (`;`, `,`, tab)
- Flexible column mapping
- Filters to target month only
- Extracts only outgoing transactions (debits)

### 2. Invoice Extraction

- **PDFs**: Local text extraction first (free), Vision API only if needed
- **Images**: OpenAI Vision API (gpt-4o-mini)
- **Caching**: MD5 hash-based, stored in `out/cache.json`

### 3. Matching Algorithm

Scores each invoice-transaction pair on:

- **Amount**: Exact or within €0.50 tolerance (50 points max)
- **Date proximity**: Within ±7 days (30 points max)
- **Vendor similarity**: Fuzzy string matching (20 points max)

Threshold: 40 points minimum for a match.

### 4. Cost Control

- **Per-request cap**: 2,000 tokens max
- **Per-run budget**: 200,000 tokens max (aborts if exceeded)
- **Warning threshold**: Alert at 75% usage
- **Detailed report**: Tokens per stage + estimated USD cost

**Typical costs** (with gpt-4o-mini):

- PDF text extraction: ~500 tokens (~$0.0003)
- Image OCR: ~1,000-1,500 tokens (~$0.0009)
- Full run (10 PDFs, 5 images): **$0.01-0.05**

## Testing prompts manually

### In ChatGPT UI (zero cost with subscription)

1. Upload a PDF or image invoice from `data/YYYY-MM/inputs/digital/` or `data/YYYY-MM/inputs/paper/`
2. Paste this prompt:

```
Extract invoice data and return ONLY valid JSON (no markdown, no explanation).

Required fields:
- vendor: supplier/company name
- invoiceNumber: invoice/receipt number (string)
- date: invoice date in dd/mm/yyyy format
- amount: total amount as number (no currency symbol)

If a field is not found, use null.

Example:
{"vendor":"ACME Corp","invoiceNumber":"INV-123","date":"15/10/2025","amount":39.99}
```

3. Verify JSON output
4. Once satisfied, run the CLI with your API key

The same prompt is used in the code with no changes.

## Configuration

Edit [config.js](config.js) to adjust:

```javascript
export const CONFIG = {
  openai: {
    model: 'gpt-4o-mini',        // Cheapest multimodal model
    maxTokensPerRequest: 2000,   // Hard cap per call
  },

  budget: {
    maxTokensPerRun: 500000,     // Abort if exceeded
    warningThreshold: 450000,    // Warn at 90%
  },

  matching: {
    amountTolerance: 1.50,       // EUR (allows for currency conversion)
    dateProximityDays: 3,
    vendorSimilarityThreshold: 0.8,
    batchSize: 30,               // Transactions per AI request
  },

  // Currency conversion
  usd2eur: 0.95,

  // Company info (used in export-bundle.js)
  company: {
    name: 'nitida',
  },
};
```

## Troubleshooting

### No transactions found

Check that CSV files are in `data/YYYY-MM/` and contain transactions for that month.

### Invoice extraction fails

- Check `OPENAI_API_KEY` is set in `.env`
- Verify API key has credits at [platform.openai.com/usage](https://platform.openai.com/usage)
- Test prompt manually in ChatGPT UI first

### Poor matching

Adjust thresholds in [config.js](config.js):

- Increase `amountTolerance` for currency rounding issues
- Increase `dateProximityDays` for delayed transactions  
- Decrease `vendorSimilarityThreshold` for fuzzy matches

## Extending the tool

### Add custom vendor cleanup rules

Edit [lib/transaction-extractor.js](lib/transaction-extractor.js):

```javascript
static cleanVendor(description) {
  let cleaned = description;
  
  // Add your rules
  cleaned = cleaned.replace(/COMPRA\s+/i, '');
  cleaned = cleaned.replace(/\d{10,}/g, '');
  
  return cleaned;
}
```

### Change OpenAI model

Edit [config.js](config.js):

```javascript
openai: {
  model: 'gpt-4o',  // More accurate but 10x more expensive
}
```

Update pricing table accordingly.

## License

MIT
