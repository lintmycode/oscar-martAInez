// Single outlet for every Telegram/notification the close job and intake send.
// OSCAR_DRY_RUN=1 prints instead of sending, so flows can be demonstrated and
// tested against real data without messaging anyone.
import { notify } from './alert.js';

export const isDryRun = () => process.env.OSCAR_DRY_RUN === '1';

// Telegram caps a message at 4096 chars; stay well under and say so.
const MAX_LEN = 3500;

export async function say(title, message) {
  const body = message.length > MAX_LEN ? `${message.slice(0, MAX_LEN)}\n…(truncated)` : message;
  if (isDryRun()) {
    console.log(`\n[DRY RUN - Telegram] ${title}\n${body.split('\n').map((l) => `  | ${l}`).join('\n')}\n`);
    return;
  }
  await notify(title, body);
}
