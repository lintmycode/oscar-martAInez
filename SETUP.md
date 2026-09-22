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
data/
└── YYYY-MM/                    # e.g., 2025-10
    ├── params.yml              # Optional: year: 2025, month: 10
    ├── inputs/
    │   ├── extracto_*.csv      # Credit card statements
    │   ├── extracto_ordem_*.csv # Bank account statements
    │   ├── paper/              # Paper invoice photos (jpg/png)
    │   └── digital/            # PDF invoices
    └── out/                    # Generated outputs (auto-created)
```

## Usage

### Step 1: Test CSV parsing (no API calls)

```bash
node test-local.js --y=2025 --m=10
```

This validates your CSV files are being read correctly without using any OpenAI credits.

### Step 2: Run full processing

```bash
node index.js --y=2025 --m=10
# or with full argument names:
node index.js --year=2025 --month=10
```

This will:
1. Extract transactions from your CSVs
2. Extract invoice data from PDFs and images (uses OpenAI API)
3. Match invoices to transactions
4. Generate Excel spreadsheet in `data/YYYY-MM/out/`

### Step 3: Check the output

Open `data/2025-10/out/2025-10.xlsx` (or whatever month you configured).

You'll find 2 sheets:
- **company account**: All company transactions with matched invoices
- **personal account**: Invoices paid personally (not in company accounts)

## Command-Line Arguments

```bash
# Required arguments
--year=YYYY, --y=YYYY    # Year (e.g., 2025)
--month=MM, --m=MM       # Month (1-12)

# Help
--help, -h               # Show usage help
```

Examples:
```bash
node index.js --y=2025 --m=10       # October 2025
node index.js --year=2025 --month=11  # November 2025
node index.js --help                # Show help
```

## Expected Costs

Using `gpt-4o-mini` (cheapest model):

- **Per invoice**: ~$0.0003-0.0009
- **Typical month** (10 PDFs, 5 images): **~$0.01-0.05**

The tool will abort if costs exceed the configured budget (200k tokens by default).

## Troubleshooting

### "No transactions found"

Check that CSV files are in `data/YYYY-MM/inputs/` and contain transactions for that month.

### "Directory not found"

Make sure you created the month directory:

```bash
mkdir -p data/2025-10/inputs/{paper,digital}
```

### "OpenAI API error"

1. Verify your API key is set in `.env`
2. Check you have credits at [platform.openai.com/usage](https://platform.openai.com/usage)
3. Test the prompt manually in ChatGPT first (see [PROMPTS.md](PROMPTS.md))

### Poor invoice matching

Adjust thresholds in [config.js](config.js):

```javascript
matching: {
  amountTolerance: 0.50,       // Increase for more flexible amount matching
  dateProximityDays: 7,         // Increase for delayed transactions
  vendorSimilarityThreshold: 0.6, // Decrease for fuzzy vendor matches
}
```

## What's Next?

1. **Test prompts in ChatGPT UI first** (see [PROMPTS.md](PROMPTS.md))
2. **Review the output** Excel file
3. **Adjust config** if needed
4. **Run monthly** with new data

The tool caches invoice extractions in `data/YYYY-MM/out/cache.json` - unchanged files are never reprocessed.

## Email Intake (optional)

Instead of manually dropping invoice files into `data/tmp/`, `poll-inbox.js` can watch a
dedicated Gmail inbox and file attachments straight into the right
`data/YYYY-MM/inputs/{paper,digital}/` folder automatically. It reuses the same
date-extraction as the monthly run, so a filed invoice is never re-extracted later - only
routing happens here, `index.js`/`export-bundle.js` still run manually as before.

### One-time setup

1. Create a dedicated Gmail account for invoice intake (e.g. forward or CC receipts to it
   as they arrive). Currently wired to `nitidaops@gmail.com`.
2. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an
   OAuth client of type **Desktop app** with the Gmail API enabled, and set
   `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` in `.env` from it.
3. Run the one-time browser auth flow (opens a URL to approve access, saves a refresh token
   to `.gmail-token.json` - gitignored, never expires unless you revoke access):

```bash
npm run gmail:auth
```

4. Test it manually:

```bash
npm run poll-inbox
```

Any email in that inbox with an unread PDF/JPG/PNG/HEIC attachment gets filed and labeled
`Oscar/Processed` + marked read, so it's never picked up twice. HEIC photos (iPhone default)
are converted to JPEG via macOS `sips` before filing. Anything whose invoice date can't be
determined is left in `data/tmp/needs-review/` and logged instead of guessed - that still
counts as handled, so the email is labeled and won't be re-downloaded.

If the *extraction service itself* fails (no OpenAI credits, rate limit exhausted, network
down), that's treated differently: the attachment is **not** filed to `needs-review`, and the
email is left unread so the next run retries it. Filing it would disguise a fixable outage as
a manual-review task, and because the email would stay unread the same attachment would be
re-downloaded under a fresh `-N` name every 10 minutes.

Emails with **no attachment** (HTML-only receipts, e.g. Apple's) only get rendered to PDF and
processed if their subject matches a pattern in `email-invoice-subjects.txt` (wildcard `*`
patterns, same style as `exclusions.txt`) - add a line there whenever a new HTML-only vendor
shows up. Anything not listed is left unread rather than rendered, since rendering runs
headless Chrome + OpenAI on the email's actual content.

### Running on a schedule

A launchd job (`launchd/com.nitida.oscar.pollinbox.plist`) polls every 10 minutes:

```bash
cp launchd/com.nitida.oscar.pollinbox.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nitida.oscar.pollinbox.plist
```

Logs land in `logs/poll-inbox.log` / `logs/poll-inbox.error.log`. To stop it:

```bash
launchctl bootout gui/$(id -u)/com.nitida.oscar.pollinbox
```

### Failure alerts

Because the job runs headless, failures used to be visible only in the error log - an expired
Gmail refresh token once went unnoticed for 7 days and 516 failed runs. `lib/alert.js` now
raises a macOS notification after **3 consecutive failed runs** (~30 min, long enough to ride
out a closed laptop lid), and one more when polling recovers. It notifies once per outage,
not once per run.

Health state lives in `logs/.poll-health.json` (local to this machine, not the shared data root); delete it to reset. To check whether the
poller is currently healthy:

```bash
cat logs/.poll-health.json   # absent or consecutiveFailures: 0 means healthy
launchctl print gui/$(id -u)/com.nitida.oscar.pollinbox | grep "last exit code"
```

**Gmail token caveat**: if the Google Cloud OAuth consent screen is still in *Testing* status,
the refresh token expires every **7 days** and every run then fails with `invalid_grant`.
Re-auth with `npm run gmail:auth`, or publish the consent screen to stop it recurring.

**Caveat**: the plist points at a specific nvm-managed Node binary path
(`~/.nvm/versions/node/v24.16.0/bin/node`). If you upgrade Node via nvm, update that path in
the plist and re-bootstrap, or the scheduled runs will silently fail (check the error log).

## Multiple Months

You can manage multiple months easily:

```bash
# October 2025
mkdir -p data/2025-10/inputs/{paper,digital}
# Add files...
node index.js --y=2025 --m=10

# November 2025
mkdir -p data/2025-11/inputs/{paper,digital}
# Add files...
node index.js --y=2025 --m=11
```

Each month's data and outputs are kept separate in `data/YYYY-MM/`.
