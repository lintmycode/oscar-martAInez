# Uninstall / Stop

## Email intake (poll-inbox.js, cron on echo)

Stop the scheduled polling without removing anything else: on echo, `crontab -e` and comment
out the `cron/poll-inbox.sh` line. Uncomment it to resume.

To fully remove it:

```bash
# on echo
crontab -e                      # delete the cron/poll-inbox.sh line
rm ~/oscar/.gmail-token.json    # the stored Gmail refresh token
# on the laptop, if a copy is still there
rm ~/projects/oscar/.gmail-token.json
```

Then also revoke the app's access from the Google account side (the local token deletion
above doesn't do this): sign in as `nitidaops@gmail.com` at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions) and remove
the OAuth client's access. Re-running `npm run gmail:auth` re-authorizes from scratch if
you want it back later.

`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` in `.env` can stay - they're inert without the token.
