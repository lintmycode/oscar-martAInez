#!/usr/bin/env node
// One-time setup: run `npm run gmail:auth`, open the printed URL signed in
// as the invoice-intake Gmail account, and approve access. Saves a refresh
// token to .gmail-token.json (gitignored) that poll-inbox.js reuses forever
// after, until the grant is revoked.
import 'dotenv/config';
import { runAuthFlow } from './lib/gmail-auth.js';

runAuthFlow().catch((error) => {
  console.error(`\n❌ Auth failed: ${error.message}\n`);
  process.exit(1);
});
