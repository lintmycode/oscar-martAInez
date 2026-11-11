// "sem fatura" waiver emails: Nuno replies to Oscar's Telegram list by emailing
// the intake inbox with subject `sem fatura` and the row numbers in the body.
//   3 anuidade cartão        -> waive #3 with a reason
//   3, 5                     -> waive #3 and #5
// Everything here works on a Gmail API message payload (no network), so it is
// unit-tested with fake payloads - poll-inbox.js only adds the Gmail glue.
import { appendWaivers } from './waivers.js';
import { monthsWithStatus, readState } from './close-state.js';

const headerValue = (payload, name) => payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || null;

/** "Nuno <nuno@x.pt>" -> "nuno@x.pt" (lowercase) */
export function parseAddress(from) {
  const m = /<([^>]+)>/.exec(from || '');
  return (m ? m[1] : from || '').trim().toLowerCase();
}

export function ownerAddresses() {
  return (process.env.OSCAR_OWNER_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** @returns {null | {month: string|null}} null = not a waiver email */
export function parseWaiverSubject(subject) {
  const stripped = String(subject || '').replace(/^(\s*(re|fwd?)\s*:\s*)+/i, '').trim();
  if (!/^sem\s+fa[ct]*ura\b/i.test(stripped)) return null; // fatura / factura
  const iso = /\b(\d{4})-(\d{2})\b/.exec(stripped);
  const mmyyyy = /\b(\d{2})[/-](\d{4})\b/.exec(stripped);
  const month = iso ? `${iso[1]}-${iso[2]}` : mmyyyy ? `${mmyyyy[2]}-${mmyyyy[1]}` : null;
  return { month };
}

function decode(part) {
  return Buffer.from(part.body.data, 'base64url').toString('utf8');
}

export function extractBodyText(payload) {
  let plain = null;
  let html = null;
  const walk = (p) => {
    if (!p || p.mimeType === 'message/rfc822') return;
    if (p.mimeType === 'text/plain' && p.body?.data && plain === null) plain = decode(p);
    if (p.mimeType === 'text/html' && p.body?.data && html === null) html = decode(p);
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  if (plain !== null) return plain;
  return (html || '').replace(/<br\s*\/?>|<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');
}

/** Body -> [{num, reason}]. Quoted text, signatures and lines not starting with a number are ignored. */
export function parseWaiverBody(text) {
  const entries = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (/^\s*>/.test(raw)) continue;
    if (/^(--\s*$|on .+ wrote:|em .+ escreveu:)/i.test(raw.trim())) break; // signature / quoted reply starts here
    let rest = raw.trim();
    const nums = [];
    // Leading list of numbers ("3", "#3", "3, 5", "3 5 and 7"); the first
    // non-number token starts the reason, so "3 2x charge" is #3 + "2x charge".
    for (;;) {
      const m = /^#?(\d+)(?=$|[\s,;&:-])/.exec(rest);
      if (!m) break;
      nums.push(Number(m[1]));
      rest = rest.slice(m[0].length).replace(/^\s*(?:[,;&]|\b(?:e|and)\b(?=\s+#?\d))?\s*/i, '');
    }
    if (!nums.length) continue;
    const reason = rest.replace(/^[-:–—]\s*/, '').trim();
    for (const num of nums) entries.push({ num, reason });
  }
  return entries;
}

// Gmail stamps Authentication-Results on inbound mail. The From header alone
// is trivially forged, so refuse a message that visibly failed SPF/DKIM/DMARC.
// (Absent header = tests / unusual delivery path: the From check still applies.)
function failedAuthentication(payload) {
  const auth = headerValue(payload, 'Authentication-Results') || '';
  return /\b(spf|dkim|dmarc)=fail\b/i.test(auth);
}

/**
 * Handle one inbox message that might be a waiver request.
 * @returns {{kind:'not-waiver'}
 *         | {kind:'rejected', reason:string}
 *         | {kind:'handled', month:string|null, text:string, waived:number[], unknown:number[]}}
 */
export async function processWaiverEmail({ payload, owners = ownerAddresses() }) {
  const subject = parseWaiverSubject(headerValue(payload, 'Subject'));
  if (!subject) return { kind: 'not-waiver' };

  // Anyone can email the inbox, so a waiver (which silences a missing-invoice
  // check that feeds the accountant) is accepted ONLY from Nuno's own addresses.
  const from = parseAddress(headerValue(payload, 'From'));
  if (!owners.length) return { kind: 'rejected', reason: 'OSCAR_OWNER_EMAILS is not set' };
  if (!owners.includes(from)) return { kind: 'rejected', reason: `sender ${from} is not an owner address` };
  if (failedAuthentication(payload)) return { kind: 'rejected', reason: `sender ${from} failed SPF/DKIM/DMARC` };

  const entries = parseWaiverBody(extractBodyText(payload));
  if (!entries.length) {
    return { kind: 'handled', month: null, waived: [], unknown: [], text: 'Got a "sem fatura" email but found no row numbers in the body (expected e.g. "3 anuidade cartão" or "3, 5").' };
  }

  // Which month? Open = still being chased (bundled-incomplete too: its
  // missing rows can still be waived before a --rebundle).
  const open = (await monthsWithStatus('open', 'bundled-incomplete')).map((x) => x.month);
  let month = subject.month;
  if (month && !open.includes(month)) {
    return { kind: 'handled', month, waived: [], unknown: [], text: `"sem fatura ${month}": that month is not open for close (open: ${open.join(', ') || 'none'}). Nothing waived.` };
  }
  if (!month) {
    if (open.length !== 1) {
      return { kind: 'handled', month: null, waived: [], unknown: [], text: open.length
        ? `More than one month is open (${open.join(', ')}): put the month in the subject, e.g. "sem fatura ${open[0]}". Nothing waived.`
        : 'No month is open for close, nothing to waive.' };
    }
    month = open[0];
  }

  const state = await readState(month);
  const waived = [];
  const unknown = [];
  const toWrite = [];
  for (const { num, reason } of entries) {
    const item = state.registry.byNum[num];
    if (!item) { unknown.push(num); continue; }
    toWrite.push({ ...item, reason });
    waived.push(num);
  }
  await appendWaivers(month, toWrite);

  const lines = waived.map((n) => {
    const it = state.registry.byNum[n];
    return `#${n} ${it.description} ${Number(it.amount).toFixed(2)}`;
  });
  let text = waived.length ? `Waived for ${month}: ${lines.join(', ')}` : `Nothing waived for ${month}.`;
  if (unknown.length) text += `\nUnknown number${unknown.length > 1 ? 's' : ''}: ${unknown.map((n) => `#${n}`).join(', ')} (not in the list Oscar sent).`;
  return { kind: 'handled', month, waived, unknown, text };
}
