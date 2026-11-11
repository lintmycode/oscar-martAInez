# Monthly close: auto-run, chase what's missing, deliver the bundle

Status: **built, not deployed** (U1-U3, 2026-11-11; U4 bundle delivery is built separately). Deploy = merge, add the cron line below on echo, set `OSCAR_OWNER_EMAILS` / `OSCAR_REPORT_TO` in echo's `.env`. **October 2026 is the test month** (opens 14/11).

## Goal

On the **14th of each month**, Oscar closes the **previous month** without being asked:

1. works out what is still missing (bank extracts, invoices for company transactions),
2. asks Nuno for it on Telegram and keeps reminding until it has everything,
3. builds the accountant bundle, then sends a Telegram notice **and an email with the zip**.

Oscar can't fetch bank extracts (CGD has no API), so those always come from Nuno, by email
to the intake inbox or uploaded to the echo.ops share.

## What exists today

| Step | Today | Runs |
|---|---|---|
| Invoice intake | `poll-inbox.js`: Gmail → `YYYY-MM/inputs/{digital,paper}` by invoice date, Telegram summary | cron on echo, every 10 min |
| Extracts | copied by hand into `YYYY-MM/inputs/*.csv` | manual |
| Month run | `index.js --y --m`: CSV + invoices → `out/YYYY-MM.xlsx` + `out/summary.json` | manual, laptop |
| Bundle | `export-bundle.js`: folder + `bundles/nitida-export-YYYY-MM.zip` | manual |
| Delivery | Nuno sends the zip to the accountant | manual |

## What "complete" means for month M

All of these must hold:

1. **Extracts present and covering M** (detected by content, not filename; the existing
   names aren't consistent, e.g. `cc-mai` but `ordem-may`):
   - *Conta à ordem*: header `Consultar saldos e movimentos à ordem`; its
     `Intervalo de;DD-MM-YYYY a DD-MM-YYYY` must cover 1st–last day of M.
   - *Cartão*: header `Consultar saldos e movimentos de cartões`; statements
     `Extrato ;MM-YYYY` for **M and M+1** (card charges from late M post on the next
     statement; every month since 2026-05 has used both).
2. **No company transaction without an invoice**: no yellow row in the company sheet,
   ignoring rows that already have a note from `transaction-notes.txt` or a per-month waiver
   (see U2).
3. **Nothing in `tmp/needs-review/`** dated in M or with no date. Files there have no month,
   so they're listed until Nuno moves or deletes them.

Unmatched *invoices* (personal sheet) don't block; they're reported in the bundle notice.

## Flow

```
14th 09:00 (Lisbon) ── close check for M-1
   │
   ├─ extracts missing? ──► Telegram: "Oscar needs for October: CGD à ordem 01-31/10; card statements 10-2026 and 11-2026"
   │
   ├─ extracts OK → run month (index.js) → unmatched company rows?
   │        └─► Telegram: list date · description · amount for each row, plus needs-review files
   │
   └─ complete → bundle → Telegram "bundle ready" + email with the zip → state: bundled

Re-check: after each poll run that filed something into an open month, or when that month's
inputs change (an extract dropped on the share). Reminder: **daily** at 09:00 while still
open, listing only what is still missing ("3 of 5 found since last time"). The accountant
needs the bundle by the **20th**: if still incomplete then, Oscar bundles and emails what it
has, with the missing items listed.
```

## Units

### U1. Extract intake

- `lib/extract-classifier.js`: reads a CSV's header (latin1/utf8, same detection as
  `csv-parser.js`) and returns `{type: 'ordem'|'cartao', months: [...]}` or `null`.
  - ordem → every month its interval fully covers (a 3-month export fills 3 months);
  - cartão `Extrato MM-YYYY` → months MM-1 and MM (it is M+1's statement for M-1).
- **By email**: `poll-inbox.js` also accepts `.csv` attachments. A classified CSV is copied
  into each target month's `inputs/`. An unrecognised CSV is left unprocessed and reported.
  It's added to the Telegram summary ("extrato cartão 11-2026 → 2026-10, 2026-11").
- **By upload**: a drop folder `echo.ops/oscar/inbox/` is scanned each poll run and the
  same classifier files the CSVs (the file is then moved to `inbox/filed/`). Dropping straight
  into `YYYY-MM/inputs/` keeps working.
- Same file twice (same content hash) is skipped, not duplicated.

### U2. Month status ("what's missing")

- Refactor `index.js` so the run is a function (`runMonth(month)`) that the CLI and the
  close job both call; CLI behaviour stays identical.
- `summary.json` gains `missingInvoices: [{date, description, amount}]` (the yellow rows).
- `lib/month-status.js`: `status(month)` → `{extracts: {ordem, cartao: {M, M+1}}, missingInvoices, needsReview, complete}`.
  It only re-runs `runMonth` when inputs changed since the last run (file list + mtimes
  fingerprint in the state file). Invoice sidecars are cached, so a re-run costs ~nothing.
- **Waivers** (decided: by email). Transactions that will never have an invoice (card
  fee, refund, mistaken transfer returned) need a way to stop Oscar asking:
  - Each missing row gets a **number** the first time it is listed (stored in `close.json`,
    never reused within the month). Requests and reminders show it: `#3 03/10 · ANUIDADE
    CARTAO · 45.00`.
  - Nuno emails the intake inbox with subject **`sem fatura`** and the numbers in the body,
    an optional reason after each number (`3 anuidade cartão` / `3, 5`). If more than one
    month is open, the subject must name it (`sem fatura 2026-10`); otherwise the
    numbers apply to the one open month.
  - `poll-inbox.js` handles it before the invoice path: it accepts it **only from Nuno's
    addresses** (`OSCAR_OWNER_EMAILS` in .env; anyone can email the inbox), appends the
    rows to `YYYY-MM/waivers.txt`, labels the email `Oscar/Processed`, and confirms on
    Telegram ("Waived #3 ANUIDADE CARTAO 45.00, #5 …"). Unknown numbers are reported back.
  - `waivers.txt` is also editable on the share. Waived rows appear in the sheet with
    the reason as the note, like `transaction-notes.txt` rows. Recurring cases still go in
    `transaction-notes.txt`.

### U3. Close job

- `close-month.js [--month=YYYY-MM | --due]`, state in `YYYY-MM/close.json`:
  `{status: open|bundled, openedAt, lastReminderAt, lastFingerprint, lastMissing, bundledAt, bundleSha}`.
- `--due` (cron): opens M-1 on/after the 14th if it has no state yet; for each open month,
  runs status. If complete → U4. Otherwise it sends the request (first time) or the daily
  reminder.
- crontab on echo (system TZ is UTC and Ubuntu's cron doesn't reliably support `CRON_TZ`, so
  the schedule is pinned in UTC): `0 9 * * * …/cron/close-month.sh` = 09:00 Lisbon in winter,
  10:00 in summer (daily; the job decides whether today warrants a message, and computes
  "today" in Europe/Lisbon itself).
- `poll-inbox.js` calls the status check for open months at the end of a run that filed
  something. That way the bundle goes out minutes after the last missing piece lands,
  not the next morning.
- Late arrival in a **bundled** month: Telegram flags it ("late invoice for 2026-10, bundle
  not updated, run `close-month.js --month=2026-10 --rebundle`"). No automatic re-send.

### U4. Bundle delivery

- `export-bundle.js` as a function (CLI unchanged).
- **Size** (decided: shrink): Gmail caps a message at 25 MB, and 2026-06's zip was 26.8 MB. In the bundle copy
  only, photos are resized to ≤ 2000 px on the long edge, JPEG q85 (sharp). Originals stay in
  `inputs/`. If the zip is still > 20 MB, the email carries the path on the share instead of the attachment.
- **Email**: Gmail API `users.messages.send` from the intake account (the existing
  `gmail.modify` scope allows sending, so no re-auth is needed) to Nuno only (`OSCAR_REPORT_TO` in .env); he reviews and forwards to the accountant (decided). Subject
  `nítida — contabilidade 2026-10`; body = summary (rows, matched, waived, personal
  total, unmatched invoices); zip attached.
- **Telegram**: "📦 Oscar: bundle 2026-10 ready, emailed to you (N files, X MB)".

### U5. Docs

README/SETUP: monthly close section, waivers, drop folder, the new cron line; this spec's
status updated.

## Out of scope

- Fetching extracts from CGD (no API).
- Answering Oscar from Telegram. Waivers go by email (U2); Telegram replies via Beth could
  come later.
- Sending straight to the accountant (decided: Nuno only).

## Decisions (2026-11-11)

1. Email goes to Nuno only.
2. Photos are shrunk in the bundle copy.
3. Reminders are daily. The **20th is a deadline**: bundle as soon as complete; if still
   incomplete on the 20th at 09:00, bundle and email what exists anyway, with the missing
   items listed at the top of the email (state `bundled-incomplete`; a later
   `--rebundle` sends the full one).
4. Waivers by email: subject `sem fatura`, numbers from Oscar's list, owner addresses only.
5. October 2026 is the test month.

## Open questions

None. Ready to build.
