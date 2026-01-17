# Quick Setup Guide

## Prerequisites

- Node.js v18+ installed
- OpenAI API key (get from [platform.openai.com/api-keys](https://platform.openai.com/api-keys))

## Installation

```bash
npm install
```

## Configuration

1. Copy the environment template:

```bash
cp .env.example .env
```

2. Edit `.env` and add your OpenAI API key:

```
OPENAI_API_KEY=sk-proj-your-key-here
```

## Directory Structure

Your working directory should look like this:

```
├── params.yml              # Target month configuration
├── inputs/                 # Your monthly data
│   ├── extracto_cc_*.csv   # Credit card statements
│   ├── extracto_ordem_*.csv # Bank account statements
│   ├── paper/              # Paper invoice photos (jpg/png)
│   └── digital/            # PDF invoices
└── out/                    # Generated outputs (auto-created)
```

## Usage

### Step 1: Test CSV parsing (no API calls)

```bash
node test-local.js
```

This validates your CSV files are being read correctly without using any OpenAI credits.

### Step 2: Run full processing

```bash
node index.js
# or
npm start
```

This will:
1. Extract transactions from your CSVs
2. Extract invoice data from PDFs and images (uses OpenAI API)
3. Match invoices to transactions
4. Generate Excel spreadsheet in `out/`

### Step 3: Check the output

Open `out/2025-10.xlsx` (or whatever month you configured).

You'll find 2 sheets:
- **company account**: All company transactions with matched invoices
- **personal account**: Invoices paid personally (not in company accounts)

## Expected Costs

Using `gpt-4o-mini` (cheapest model):

- **Per invoice**: ~$0.0003-0.0009
- **Typical month** (10 PDFs, 5 images): **~$0.01-0.05**

The tool will abort if costs exceed the configured budget (200k tokens by default).

## Troubleshooting

### "No transactions found"

Check that `params.yml` month/year matches your data:

```yaml
year: 2025
month: 10
```

### "OpenAI API error"

1. Verify your API key is set in `.env`
2. Check you have credits at [platform.openai.com/usage](https://platform.openai.com/usage)
3. Test the prompt manually in ChatGPT first (see `PROMPTS.md`)

### Poor invoice matching

Adjust thresholds in `config.js`:

```javascript
matching: {
  amountTolerance: 0.50,       // Increase for more flexible amount matching
  dateProximityDays: 7,         // Increase for delayed transactions
  vendorSimilarityThreshold: 0.6, // Decrease for fuzzy vendor matches
}
```

## What's Next?

1. **Test prompts in ChatGPT UI first** (see `PROMPTS.md`)
2. **Review the output** Excel file
3. **Adjust config** if needed
4. **Run monthly** with new data

The tool caches invoice extractions in `out/cache.json` - unchanged files are never reprocessed.
