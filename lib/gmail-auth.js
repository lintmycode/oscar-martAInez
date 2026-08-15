import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import { google } from 'googleapis';

const TOKEN_PATH = path.join(process.cwd(), '.gmail-token.json');

// gmail.modify (not readonly) is required so poll-inbox.js can clear the
// UNREAD label and apply "Oscar/Processed" after filing an invoice - that's
// what stops the same email being picked up again on the next poll.
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

function buildOAuthClient() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET missing from .env');
  }
  return new google.auth.OAuth2(clientId, clientSecret);
}

/**
 * Build an OAuth2 client from the token saved by runAuthFlow(). googleapis
 * auto-refreshes the access token from the stored refresh_token as needed.
 */
export async function getOAuthClient() {
  const client = buildOAuthClient();
  const raw = await fs.readFile(TOKEN_PATH, 'utf8').catch(() => null);
  if (!raw) {
    throw new Error(
      `No stored Gmail token at ${TOKEN_PATH}. Run "npm run gmail:auth" once first.`
    );
  }
  client.setCredentials(JSON.parse(raw));
  return client;
}

/**
 * One-time interactive OAuth flow (loopback redirect - the "Desktop app"
 * OAuth client type Google issues accepts any localhost port, so no fixed
 * redirect URI needs pre-registering). Run manually via gmail-auth-setup.js.
 */
export async function runAuthFlow() {
  const client = buildOAuthClient();
  const server = http.createServer();
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  const redirectUri = `http://127.0.0.1:${port}`;
  client.redirectUri = redirectUri;

  const authUrl = client.generateAuthUrl({
    access_type: 'offline', // required to get back a refresh_token
    prompt: 'consent', // force re-issuing refresh_token even if previously granted
    scope: SCOPES,
    redirect_uri: redirectUri,
  });

  console.log('\nOpen this URL, signed in as the invoice-intake Gmail account:\n');
  console.log(authUrl + '\n');
  console.log('Waiting for authorization...');

  const code = await new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url, redirectUri);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.end(error ? 'Authorization failed - check the terminal.' : 'Authorized, you can close this tab.');
      server.close();
      if (error) reject(new Error(error));
      else if (code) resolve(code);
    });
    server.on('error', reject);
  });

  const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
  await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log(`\nSaved refresh token to ${TOKEN_PATH}`);
}
