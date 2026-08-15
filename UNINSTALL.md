# Uninstall / Stop

## Email intake (poll-inbox.js + launchd)

Stop the scheduled polling without removing anything else:

```bash
launchctl bootout gui/$(id -u)/com.nitida.oscar.pollinbox
```

This stops it immediately and it won't restart on next login, but the job definition
stays installed - `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nitida.oscar.pollinbox.plist`
resumes it later with no further setup.

To fully remove it:

```bash
# 1. Stop it (ignore "Could not find service" if it wasn't running)
launchctl bootout gui/$(id -u)/com.nitida.oscar.pollinbox

# 2. Remove the installed job definition
rm ~/Library/LaunchAgents/com.nitida.oscar.pollinbox.plist

# 3. Remove the stored Gmail refresh token
rm ~/projects/oscar/.gmail-token.json
```

Then also revoke the app's access from the Google account side (the local token deletion
above doesn't do this): sign in as `nitidaops@gmail.com` at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions) and remove
the OAuth client's access. Re-running `npm run gmail:auth` re-authorizes from scratch if
you want it back later.

`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` in `.env` and `launchd/com.nitida.oscar.pollinbox.plist`
in the repo can stay - they're inert without the token and the running launchd job.
