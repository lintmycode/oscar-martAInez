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

Any inbox email from the last 30 days with a PDF/JPG/PNG attachment and **no
`Oscar/Processed` label** gets filed, then labeled `Oscar/Processed` + marked read, so it's
never picked up twice. Read/unread doesn't matter (since 2026-11-11 - opening an email in
Gmail used to hide it from the poller). HEIC is not accepted (echo has no `sips`; photos are
sent as JPG by agreement) - a HEIC-only email is left unlabeled for a manual look. Landscape photos are treated as receipts
shot sideways and a copy is rotated 90° counter-clockwise before extraction (the filed photo
is left as sent). Anything whose invoice date can't be
determined is left in `data/tmp/needs-review/` and logged instead of guessed - that still
counts as handled, so the email is labeled and won't be re-downloaded.

**Year correction:** the vision model misreads receipt years. A date more than a year before
the email (or over a month after it) keeps its day/month but takes the email's year (or the
year before, if that would land after the email), logged as `YEAR CORRECTED`; the model's
reading stays in the sidecar JSON as `originalDate`. A genuinely old receipt sent by email
would therefore be filed in the wrong year - move it by hand.

If the *extraction service itself* fails (no OpenAI credits, rate limit exhausted, network
down), that's treated differently: the attachment is **not** filed to `needs-review`, and the
email is left unlabeled so the next run retries it. Filing it would disguise a fixable outage as
a manual-review task, and because the email would stay unlabeled the same attachment would be
re-downloaded under a fresh `-N` name every 10 minutes.

Emails with **no attachment** (HTML-only receipts, e.g. Apple's) only get rendered to PDF and
processed if their subject matches a pattern in `email-invoice-subjects.txt` (wildcard `*`
patterns, same style as `exclusions.txt`) - add a line there whenever a new HTML-only vendor
shows up - a skipped email is re-checked every run for 30 days, so it is picked up on the
next run after its subject is added. Anything not listed is left unprocessed rather than rendered, since rendering runs
headless Chrome + OpenAI on the email's actual content.

### Running on a schedule (echo)

Since 2026-11-11 the poller runs on **echo** (always on, share auto-mounted), not the laptop:
the laptop only reached `/Volumes/echo.ops` when someone mounted it by hand, and intake
silently stopped for a month. Run it in exactly one place - two pollers would race for the
same emails.

Setup on echo (`ssh nuno@echo`):

```bash
git clone git@github.com:lintmycode/oscar-martAInez.git ~/oscar && cd ~/oscar && npm ci
# from the laptop: scp .env .gmail-token.json echo:oscar/
# then in ~/oscar/.env on echo:
#   OSCAR_DATA_ROOT=/mnt/echo-ops/oscar
#   CHROME_PATH=/home/nuno/.cache/puppeteer/chrome-headless-shell/linux-<ver>/chrome-headless-shell-linux64/chrome-headless-shell
#   TELEGRAM_CHAT_ID=<nuno's DM id>
crontab -e   # add: */10 * * * * /home/nuno/oscar/cron/poll-inbox.sh
```

`cron/poll-inbox.sh` takes a lock (a big backlog can outlast 10 minutes) and appends to
`logs/poll-inbox.log` / `logs/poll-inbox.error.log`. Deploying a change = `git pull` in
`~/oscar` (plus `npm ci` if dependencies changed). To stop it, comment out the crontab line.

**AppArmor (one-time, root):** Ubuntu 24 blocks the user namespaces Chrome's sandbox needs
("No usable sandbox!"), so `/etc/apparmor.d/oscar-chrome-headless-shell` (installed
2026-11-11) grants `userns` to the puppeteer headless shell only - the sandbox stays on:

```
abi <abi/4.0>,
include <tunables/global>
profile oscar-chrome-headless-shell /home/nuno/.cache/puppeteer/chrome-headless-shell/linux-*/chrome-headless-shell-linux64/chrome-headless-shell flags=(unconfined) {
  userns,
}
```

Load with `sudo apparmor_parser -r /etc/apparmor.d/oscar-chrome-headless-shell`. If the
headless shell moves out of `~/.cache/puppeteer`, the profile path must follow.

`CHROME_PATH` is only used to render HTML-only receipts to PDF; it defaults to the Mac's
Chrome for manual runs on the laptop. If the puppeteer cache on echo is updated, the versioned
path changes - `npx @puppeteer/browsers install chrome-headless-shell@stable` reinstalls one.

### Failure alerts

Because the job runs headless, failures used to be visible only in the error log - an expired
Gmail refresh token once went unnoticed for 7 days and 516 failed runs, an unmounted share for
a month. `lib/alert.js` sends a **Telegram DM** (Beth's bot, token read from
`~/.openclaw/openclaw.json`, chat id from `TELEGRAM_CHAT_ID`) after **3 consecutive failed
runs** (~30 min), repeats it **every 24h** while the outage lasts, and sends one more when
polling recovers. Each alert carries a "Fix:" line for the known failures (Gmail login
expired, share not mounted, OpenAI failing). Manual runs on the Mac use a macOS notification
instead.

Every run that files something also sends one **"Oscar: N invoices filed"** Telegram summary
(vendor, amount, date → month folder, plus year corrections and needs-review items). Skipped
emails aren't included - they're re-checked every run and would repeat every 10 minutes.

Health state lives in `logs/.poll-health.json` (local to this machine, not the shared data root); delete it to reset. To check whether the
poller is currently healthy:

```bash
cat logs/.poll-health.json   # absent or consecutiveFailures: 0 means healthy
tail logs/poll-inbox.error.log
```

**Gmail token caveat**: if the Google Cloud OAuth consent screen is still in *Testing* status,
the refresh token expires every **7 days** and every run then fails with `invalid_grant`.
Re-auth needs a browser, so run `npm run gmail:auth` on the laptop and
`scp .gmail-token.json echo:oscar/` - or publish the consent screen (Google Cloud console →
OAuth consent screen → Publish app) to stop it recurring.

## Monthly close

From the **14th** of each month Oscar closes the **previous** month without being asked: it works
out what is missing, asks on Telegram, reminds daily, and hands the bundle to
`lib/deliver-bundle.js` (U4) as soon as everything is there. Spec: `specs/monthly-close.md`.

A month is **complete** when all hold:

1. **Extracts present**, detected by *content* (filenames are inconsistent): a CGD current-account
   export whose `Intervalo de` covers the whole month, and card statements `Extrato MM-YYYY` for
   **M and M+1** (late-M card charges post on the next statement).
2. **No company transaction without an invoice** (yellow rows), ignoring rows explained by
   `transaction-notes.txt` or a waiver.
3. **Nothing in `tmp/needs-review/`** dated in M or undated.

### Getting extracts in

- **Email** the CSV to the intake inbox: `poll-inbox.js` classifies it and files it into every month
  it covers (a 3-month export fills 3 months; a card statement fills its month and the one before).
  Same file twice (same content hash) is skipped. An unrecognised CSV is left unprocessed and
  reported once on Telegram.
- **Drop folder**: put the CSV in `oscar/inbox/` on the echo.ops share. The next poll run files it
  and moves it to `inbox/filed/` (or `inbox/unrecognised/`).
- Dropping straight into `YYYY-MM/inputs/` still works.

### Waivers ("this one will never have an invoice")

Every missing row is listed on Telegram with a number the first time it appears
(`#3 03/10 · ANUIDADE CARTAO · 45.00`); numbers are stored in `YYYY-MM/close.json` and never
reused within the month. Email the intake inbox with subject **`sem fatura`** and the numbers in
the body, optionally with a reason: `3 anuidade cartão` or `3, 5`. With more than one open month,
name it in the subject: `sem fatura 2026-10`.

- Accepted **only** from addresses in `OSCAR_OWNER_EMAILS` (comma-separated, in `.env`): anyone can
  email the inbox. Mail that failed SPF/DKIM/DMARC is refused too. Anything else is ignored and
  reported once.
- Each waiver is appended to `YYYY-MM/waivers.txt` (editable on the share by hand):
  `DD/MM/YYYY | DESCRIPTION | AMOUNT → reason`. Waived rows show the reason as the note in the sheet.
  Recurring cases still belong in `transaction-notes.txt`.
- Unknown numbers are reported back; the confirmation lists what was waived.

### Running it

```bash
node close-month.js --due                    # what cron runs daily
node close-month.js --month=2026-10          # check one month now (always prints the list)
node close-month.js --month=2026-10 --rebundle   # re-run and send a fresh bundle
```

- `--due` opens M-1 from the 14th, then for each open month: complete -> deliver bundle;
  otherwise the request (first time) or the **daily reminder** (only what is still missing, with
  "N of M found since last time"). At most one message per month per day.
- **The 20th is a deadline**: if still incomplete on/after the 20th of M+1, it delivers an
  *incomplete* bundle (`deliverBundle({ incomplete: true, missing })`) and sets state
  `bundled-incomplete`. `--rebundle` later sends the full one.
- `poll-inbox.js` re-checks open months after a run that filed anything (invoice, extract,
  waiver), so the bundle goes out minutes after the last piece lands; it only messages then if the
  missing list changed.
- A late arrival in an already-bundled month gets a Telegram flag; nothing is re-sent automatically.
- State per month: `YYYY-MM/close.json` (`status` open / bundled / bundled-incomplete, reminder
  bookkeeping, the number registry). `out/summary.json` has `missingInvoices` and `waivedRows`.

**Cron on echo** (system TZ is UTC and Ubuntu's cron doesn't reliably honour `CRON_TZ`, so the
schedule is pinned in UTC: 09:00 Lisbon in winter, 10:00 in summer; the job itself works out
"today" in Europe/Lisbon):

```
0 9 * * * /home/nuno/oscar/cron/close-month.sh
```

`cron/close-month.sh` shares `poll-inbox.sh`'s lock (they must not run the month pipeline at the
same time) and logs to `logs/close-month.log` / `logs/close-month.error.log`.

**Testing without sending anything**: `OSCAR_DRY_RUN=1` prints Telegram/email instead of sending;
`OSCAR_TODAY=2026-11-20` fakes today's date. Use a scratch `OSCAR_DATA_ROOT` (a dry run still
writes `close.json` reminder state, though never `bundled*`). `npm test` runs the unit tests
(real CGD header formats, fake Gmail payloads - nothing touches Gmail).

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
