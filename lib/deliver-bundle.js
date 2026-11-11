// Build the month's bundle and email it to Nuno (who reviews and forwards it
// to the accountant), then send a Telegram notice. Called by the close job.
//
// Sending uses the Gmail API with the intake account's existing token: the
// gmail.modify scope already permits users.messages.send, so no re-auth.
// The MIME message is built by hand to avoid a new dependency.
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { google } from 'googleapis';
import { getOAuthClient } from './gmail-auth.js';
import { getDataRoot } from './paths.js';
import { buildBundle } from './bundle.js';
import { notify } from './alert.js';

// Gmail caps a message at 25 MB, and base64 inflates the attachment by ~33%.
// A zip over 20 MB would blow the cap once encoded, so above this we send the
// path on the share instead of attaching.
const MAX_ATTACH_BYTES = 20 * 1024 * 1024;

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

// Base64, wrapped at 76 chars as MIME requires.
const b64Lines = (buf) => buf.toString('base64').replace(/(.{76})/g, '$1\r\n');

// RFC 2047 encoded-word so the em dash in the subject survives.
const encodeSubject = (s) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;

function buildBody({ month, incomplete, missing, summary, attached, sharePath, zipBytes, fileCount }) {
  const lines = [];
  if (incomplete) {
    lines.push(`ATENÇÃO: pacote INCOMPLETO - faltam ${missing.length} item(ns):`);
    for (const m of missing) lines.push(`  - ${m}`);
    lines.push('');
  }
  lines.push(`Pacote de contabilidade de ${month}.`, '');
  if (summary) {
    lines.push(
      `Linhas da empresa: ${summary.companyRows}`,
      `Faturas associadas: ${summary.matchedInvoices}`,
      `Faturas sem correspondência: ${summary.unmatchedInvoices}`,
      `Total pessoal: ${Number(summary.personalTotalCombined).toFixed(2)} EUR`,
      ''
    );
  }
  lines.push(`Ficheiros: ${fileCount} (zip com ${mb(zipBytes)} MB).`);
  if (attached) {
    lines.push('O zip segue em anexo.');
  } else {
    lines.push(`O zip é demasiado grande para anexar (limite 20 MB). Está na partilha: ${sharePath}`);
  }
  return lines.join('\r\n') + '\r\n';
}

function buildMime({ to, subject, body, zipPath, zipBuf }) {
  const boundary = `oscar-${crypto.randomBytes(12).toString('hex')}`;
  const parts = [
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lines(Buffer.from(body, 'utf8')),
  ];
  if (zipBuf) {
    const name = path.basename(zipPath);
    parts.push(
      `--${boundary}`,
      `Content-Type: application/zip; name="${name}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${name}"`,
      '',
      b64Lines(zipBuf)
    );
  }
  parts.push(`--${boundary}--`, '');
  return parts.join('\r\n');
}

/**
 * @param {{month: string, incomplete?: boolean, missing?: string[], summary?: object|null}} opts
 *   month 'YYYY-MM'; missing = already-formatted lines, listed at the top of
 *   the email when incomplete; summary = the month's out/summary.json.
 * @returns {Promise<{zipPath: string, zipBytes: number, emailed: boolean, attached: boolean}>}
 */
export async function deliverBundle({ month, incomplete = false, missing = [], summary = null }) {
  const dry = process.env.OSCAR_DRY_RUN === '1';
  const to = process.env.OSCAR_REPORT_TO;
  if (!to) throw new Error('OSCAR_REPORT_TO missing from .env');

  const { zipPath, zipBytes, fileCount } = await buildBundle(month);
  const attached = zipBytes <= MAX_ATTACH_BYTES;
  // "echo.ops" is the NAS share name; the data root is a folder on it.
  const sharePath = `echo.ops/${path.basename(getDataRoot())}/bundles/${path.basename(zipPath)}`;

  const subject = `${incomplete ? '[INCOMPLETO] ' : ''}nítida — contabilidade ${month}`; // accented in the subject only; file/zip names stay ASCII (CONFIG.company.name)
  const body = buildBody({ month, incomplete, missing, summary, attached, sharePath, zipBytes, fileCount });
  const raw = buildMime({ to, subject, body, zipPath, zipBuf: attached ? await fs.readFile(zipPath) : null });

  const tgTitle = `📦 Oscar: bundle ${month} ready`;
  const tgText = `${fileCount} files, ${mb(zipBytes)} MB, ` +
    (incomplete ? `INCOMPLETE - ${missing.length} items missing` : 'emailed to you') +
    (attached ? '' : ` (zip too big to attach: ${sharePath})`);

  if (dry) {
    const eml = path.join(getDataRoot(), 'tmp', `dry-run-email-${month}.eml`);
    await fs.mkdir(path.dirname(eml), { recursive: true });
    await fs.writeFile(eml, raw);
    console.log(`[dry run] would email ${to}: ${subject}`);
    console.log(`[dry run] attached=${attached}, message written to ${eml}`);
    console.log(`[dry run] would notify: ${tgTitle} - ${tgText}`);
    return { zipPath, zipBytes, emailed: false, attached };
  }

  try {
    const gmail = google.gmail({ version: 'v1', auth: await getOAuthClient() });
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: Buffer.from(raw).toString('base64url') },
    });
  } catch (err) {
    // Don't throw: the bundle exists on the share, and the caller must not
    // mark the month bundled when the email didn't go out (emailed: false).
    console.error(`Email send failed: ${err.message}`);
    await notify(`📦 Oscar: bundle ${month} built, EMAIL FAILED`, `${err.message}. Zip: ${sharePath}`);
    return { zipPath, zipBytes, emailed: false, attached };
  }

  await notify(tgTitle, tgText);
  return { zipPath, zipBytes, emailed: true, attached };
}
