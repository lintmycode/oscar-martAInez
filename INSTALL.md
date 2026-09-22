# Install: Email Intake

Sets up `poll-inbox.js` to watch a dedicated Gmail inbox and auto-file invoice
attachments into `<data-root>/YYYY-MM/inputs/{paper,digital}/` (the shared `echo.ops` NAS folder when `OSCAR_DATA_ROOT` is set in `.env` - see README "Using an external data directory"). See [UNINSTALL.md](UNINSTALL.md)
to stop or remove it, and SETUP.md's "Email Intake" section for how it behaves once running.

## 1. Gmail account + OAuth client (one-time, manual)

1. Create (or designate) a dedicated Gmail account for invoice intake - currently
   `nitidaops@gmail.com`.
2. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), enable the
   Gmail API and create an OAuth client of type **Desktop app**.
3. Add the client ID/secret to `.env`:
   ```
   GMAIL_CLIENT_ID=...
   GMAIL_CLIENT_SECRET=...
   ```

## 2. Authorize (one-time, interactive)

```bash
npm install
npm run gmail:auth
```

Open the printed URL signed in as the intake account, approve access. Saves a refresh
token to `.gmail-token.json` (gitignored) - `poll-inbox.js` reuses it indefinitely.

## 3. Test it manually

```bash
npm run poll-inbox
```

Send a test invoice (PDF or photo) to the intake address first and re-run - confirm it
lands in the right `data/YYYY-MM/inputs/` folder and the email gets labeled
`Oscar/Processed`.

If the vendor sends HTML-only receipts with no attachment (e.g. Apple), add its subject
pattern to `email-invoice-subjects.txt` first - that's the whitelist gating which forwarded
emails are allowed to trigger PDF rendering + extraction. Anything not listed there is left
unread, not rendered.

## 4. Schedule it (launchd, macOS-only)

```bash
cp ~/projects/oscar/launchd/com.nitida.oscar.pollinbox.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nitida.oscar.pollinbox.plist
launchctl print gui/$(id -u)/com.nitida.oscar.pollinbox | head -10   # confirm it's loaded
```

Polls every 10 minutes; logs to `logs/poll-inbox.log` / `logs/poll-inbox.error.log`.

**Note**: the plist hardcodes an nvm-managed Node path
(`~/.nvm/versions/node/v24.16.0/bin/node`). If you upgrade Node via nvm, update that path
in `launchd/com.nitida.oscar.pollinbox.plist` and re-run step 4, or the scheduled runs will
fail silently (check the error log).

**Moving this to an always-on box later** (e.g. "echo"): launchd is macOS-only. On Linux
you'd swap the plist for cron or a systemd timer calling `node poll-inbox.js` on the same
interval - the script itself doesn't change, only the scheduler.
