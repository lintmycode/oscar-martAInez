#!/usr/bin/env node
// Polls the dedicated invoice-intake Gmail account for new unread emails
// with attachments (or forwarded HTML-only receipts, rendered to PDF here -
// the automated version of "save email as PDF"), including ones batch-sent
// via Gmail's "forward as attachment" (each original email arrives as a
// message/rfc822 .eml, handled as its own source below). Figures out which
// month each invoice/receipt belongs to (reusing the same date-extraction
// the monthly run uses), and files them straight into
// data/YYYY-MM/inputs/{paper,digital}/ - the automated version of the
// "drop into data/tmp/ and route by hand" step.
//
// Intended to run unattended on a schedule (see SETUP.md - Email Intake).
// It never runs index.js/export-bundle.js - actually processing a month is
// still a deliberate, manual step.
import 'dotenv/config';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';
import { google } from 'googleapis';
import puppeteerCore from 'puppeteer-core';
import OpenAI from 'openai';
import { CONFIG } from './config.js';
import { InvoiceExtractor } from './lib/invoice-extractor.js';
import { TokenTracker } from './lib/token-tracker.js';
import { getOAuthClient } from './lib/gmail-auth.js';
import { getDataRoot } from './lib/paths.js';
import { ensureMonthScaffold } from './lib/month-scaffold.js';
import { recordFailure, recordSuccess } from './lib/alert.js';

const PROCESSED_LABEL = 'Oscar/Processed';
// Gmail-side prefilter only, to avoid re-fetching years of unrelated unread
// mail (security alerts etc) this inbox already had before being
// repurposed. The real access-control gate for HTML rendering is the
// subject whitelist below - matching this query is necessary but not
// sufficient for a message to get rendered.
const QUERY = 'is:unread -in:chats (has:attachment OR subject:(fwd OR fw))';

// HTML->PDF rendering (see renderHtmlToPdf) only runs for a message whose
// subject matches one of these patterns - anything else with no real
// attachment is left unread rather than blindly rendered+extracted. Without
// this, ANY forwarded email with "fwd"/"fw" in the subject would get run
// through headless Chrome and OpenAI regardless of content.
const SUBJECT_WHITELIST_PATH = path.join(process.cwd(), 'email-invoice-subjects.txt');

const SUPPORTED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.heif']);

// Chrome ships on this Mac already; using puppeteer-core against it avoids
// puppeteer's ~300MB bundled-Chromium download for a script that only ever
// runs on this one machine.
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main() {
  // Resolve (and existence-check) the data root before touching Gmail, so an
  // unmounted share fails the run without marking any message as read.
  const dataRoot = getDataRoot();
  const auth = await getOAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const openai = new OpenAI({ apiKey: CONFIG.openai.apiKey });
  const extractor = new InvoiceExtractor(openai, new TokenTracker());

  const processedLabelId = await ensureLabel(gmail, PROCESSED_LABEL);
  const needsReviewDir = path.join(dataRoot, 'tmp', 'needs-review');
  const subjectWhitelist = await loadSubjectWhitelist();

  const list = await gmail.users.messages.list({ userId: 'me', q: QUERY, maxResults: 50 });
  const messages = list.data.messages || [];

  if (!messages.length) {
    console.log('No new invoice emails.');
    await recordSuccess();
    return;
  }

  console.log(`Found ${messages.length} unread candidate message(s).`);

  // Lazily launched only if some message actually needs HTML->PDF rendering,
  // and shared across messages in this run rather than one launch each.
  const browserRef = { current: null };
  let infraFailures = 0;
  try {
    for (const { id: messageId } of messages) {
      infraFailures += await processMessage({ gmail, messageId, extractor, processedLabelId, needsReviewDir, browserRef, subjectWhitelist });
    }
  } finally {
    if (browserRef.current) await browserRef.current.close();
  }

  // The run didn't throw, but attachments were left unprocessed because the
  // extraction service was down - that's still an outage worth alerting on,
  // and it's exactly the state that used to loop silently.
  if (infraFailures > 0) {
    await recordFailure(`${infraFailures} attachment(s) could not be extracted`);
  } else {
    await recordSuccess();
  }
}

async function processMessage({ gmail, messageId, extractor, processedLabelId, needsReviewDir, browserRef, subjectWhitelist }) {
  const { data: message } = await gmail.users.messages.get({ userId: 'me', id: messageId });
  const outerSubject = headerValue(message.payload, 'Subject') || '(no subject)';

  // "Forward as attachment" (often used to batch-forward several selected
  // emails at once) attaches each original message as message/rfc822 -
  // Gmail's API hands that back already parsed into its own header+parts
  // tree, so each one is treated as its own source with its own subject
  // gating the whitelist below, same as if it had arrived on its own.
  const sources = [
    { subject: outerSubject, payload: message.payload },
    ...collectEmbeddedMessages(message.payload),
  ];

  // The outer subject is one you type yourself when composing the forward
  // (e.g. selecting several receipts and forwarding-as-attachment under a
  // subject like "apple faturas") - a stronger, self-authored signal than
  // an individual embedded email's own (vendor-controlled) subject line.
  // Checked first: a whitelisted outer subject authorizes every source in
  // the batch; otherwise each source still needs its own subject to match.
  const outerAuthorized = matchesWhitelist(stripSubjectPrefixes(outerSubject), subjectWhitelist);

  const candidates = sources.flatMap((source) =>
    buildCandidates({ source, gmail, messageId, subjectWhitelist, outerAuthorized, browserRef })
  );

  if (!candidates.length) {
    console.log(
      `Skipping "${outerSubject}": no pdf/jpg/png/heic attachment and no whitelisted HTML body found (including inside any forwarded .eml attachments), left unread for manual look.`
    );
    return;
  }

  let handledCount = 0;
  let infraFailures = 0;

  for (const candidate of candidates) {
    const result = await fileCandidate({ candidate, extractor, needsReviewDir });
    if (result === 'infra-failure') infraFailures += 1;
    else if (result) handledCount += 1;
  }

  // Only label the message once nothing is left to retry. A message with a
  // mix of filed and failed attachments stays unread so the next run can
  // finish it - the sidecar cache means the already-extracted ones aren't
  // paid for twice, and uniqueName() keeps the redo from overwriting.
  if (handledCount > 0 && infraFailures === 0) {
    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { removeLabelIds: ['UNREAD'], addLabelIds: [processedLabelId] },
    });
  }

  return infraFailures;
}

// Real attachments in a source always qualify; an HTML body qualifies if
// EITHER the outer batch subject was already authorized, or this source's
// own subject is separately whitelisted.
function buildCandidates({ source, gmail, messageId, subjectWhitelist, outerAuthorized, browserRef }) {
  const { subject, payload } = source;

  const attachmentCandidates = collectAttachmentParts(payload)
    .filter((p) => SUPPORTED_EXT.has(path.extname(p.filename || '').toLowerCase()))
    .map((part) => ({
      subject,
      filename: part.filename,
      ext: path.extname(part.filename).toLowerCase(),
      getBuffer: () => downloadAttachment(gmail, messageId, part),
    }));

  if (attachmentCandidates.length) return attachmentCandidates;

  const strippedSubject = stripSubjectPrefixes(subject);
  if (!outerAuthorized && !matchesWhitelist(strippedSubject, subjectWhitelist)) return [];

  const htmlPart = findHtmlPart(payload);
  if (!htmlPart) return [];

  const html = Buffer.from(htmlPart.body.data, 'base64url').toString('utf8');
  return [{
    subject,
    filename: `${slugify(strippedSubject)}.pdf`,
    ext: '.pdf',
    getBuffer: async () => {
      browserRef.current = browserRef.current || (await launchBrowser());
      return renderHtmlToPdf(browserRef.current, html);
    },
  }];
}

async function fileCandidate({ candidate, extractor, needsReviewDir }) {
  const { ext, subject } = candidate;
  const isPdf = ext === '.pdf';
  const isHeic = ext === '.heic' || ext === '.heif';
  const buffer = await candidate.getBuffer();

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oscar-inbox-'));
  const tmpPath = path.join(tmpDir, sanitizeFilename(candidate.filename));
  await fs.writeFile(tmpPath, buffer);

  // iPhones send photos as HEIC by default; the extractor's vision call
  // only knows jpg/png, so convert before anything else touches the file.
  let workingPath = tmpPath;
  let filedFilename = candidate.filename;
  if (isHeic) {
    workingPath = convertHeicToJpeg(tmpPath);
    filedFilename = path.basename(candidate.filename, ext) + '.jpg';
  }

  const invoice = isPdf
    ? await extractor.extractFromPdf(workingPath)
    : await extractor.extractFromImage(workingPath);

  // The extraction call itself failed (no credits, rate limit exhausted,
  // network down) rather than the document being unreadable. Leave the
  // email untouched so the next run retries it, and drop the temp copy -
  // filing it under needs-review would both hide a fixable outage as a
  // manual-review task and, since the email stays unread, re-download the
  // same attachment under a fresh -N name every 10 minutes.
  if (!invoice && extractor.lastFailureWasInfra) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    console.error(`  RETRY LATER: extraction service failed on "${filedFilename}" (from "${subject}") - leaving email unread.`);
    return 'infra-failure';
  }

  const monthStr = invoiceMonth(invoice?.date);

  if (!monthStr) {
    await fs.mkdir(needsReviewDir, { recursive: true });
    const destPath = path.join(needsReviewDir, uniqueName(needsReviewDir, filedFilename));
    await fs.rename(workingPath, destPath);
    console.log(
      `FLAG: could not determine an invoice date for "${filedFilename}" (from "${subject}") - left at ${destPath} for manual review.`
    );
    // Counts as handled: the file is parked for a human, so re-polling the
    // email would only produce duplicate copies of something already queued.
    return 'needs-review';
  }

  const { paperDir, digitalDir } = await ensureMonthScaffold(monthStr);
  const destDir = isPdf ? digitalDir : paperDir;
  const destName = uniqueName(destDir, filedFilename);
  await fs.rename(workingPath, path.join(destDir, destName));

  // Move the sidecar cache alongside it so index.js doesn't re-spend
  // OpenAI tokens re-extracting what poll-inbox.js just extracted.
  const sidecarSrc = extractor.getSidecarPath(workingPath);
  if (await fileExists(sidecarSrc)) {
    const sidecarDestName = path.basename(destName, path.extname(destName)) + '.json';
    await fs.rename(sidecarSrc, path.join(destDir, sidecarDestName));
  }

  console.log(`Filed "${filedFilename}" -> data/${monthStr}/inputs/${isPdf ? 'digital' : 'paper'}/${destName}`);
  return 'filed';
}

function headerValue(payload, name) {
  return payload?.headers?.find((h) => h.name === name)?.value || null;
}

function collectAttachmentParts(payload, acc = []) {
  if (!payload) return acc;
  // message/rfc822 (a forwarded-as-attachment .eml) is handled separately
  // as its own source by collectEmbeddedMessages - don't also grab it here
  // (its ".eml" filename wouldn't match SUPPORTED_EXT anyway) or descend
  // into it, which would bypass that source's own subject whitelist check.
  if (payload.mimeType === 'message/rfc822') return acc;
  if (payload.filename && payload.body && (payload.body.attachmentId || payload.body.data)) {
    acc.push(payload);
  }
  if (payload.parts) {
    for (const part of payload.parts) collectAttachmentParts(part, acc);
  }
  return acc;
}

// Finds message/rfc822 parts (forwarded-as-attachment original emails) one
// level deep - Gmail already parses each into its own header+parts tree
// (payload.parts[0]), no separate MIME parser needed. Doesn't recurse into
// an embedded message looking for further embedded messages.
function collectEmbeddedMessages(payload, acc = []) {
  if (!payload) return acc;
  if (payload.mimeType === 'message/rfc822' && payload.parts?.[0]) {
    const embeddedRoot = payload.parts[0];
    const subject = headerValue(embeddedRoot, 'Subject') || '(no subject)';
    acc.push({ subject, payload: embeddedRoot });
    return acc;
  }
  if (payload.parts) {
    for (const part of payload.parts) collectEmbeddedMessages(part, acc);
  }
  return acc;
}

async function loadSubjectWhitelist() {
  try {
    const content = await fs.readFile(SUBJECT_WHITELIST_PATH, 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map(patternToRegex);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function patternToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesWhitelist(subject, patterns) {
  return patterns.some((re) => re.test(subject));
}

function stripSubjectPrefixes(subject) {
  let stripped = subject.trim();
  let previous;
  do {
    previous = stripped;
    stripped = stripped.replace(/^(fwd|fw|re)\s*:\s*/i, '').trim();
  } while (stripped !== previous);
  return stripped;
}

function findHtmlPart(payload) {
  if (!payload) return null;
  if (payload.mimeType === 'message/rfc822') return null;
  if (payload.mimeType === 'text/html' && payload.body?.data) return payload;
  for (const part of payload.parts || []) {
    const found = findHtmlPart(part);
    if (found) return found;
  }
  return null;
}

function slugify(text) {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || 'email';
}

async function launchBrowser() {
  return puppeteerCore.launch({ executablePath: CHROME_PATH, headless: true });
}

async function renderHtmlToPdf(browser, html) {
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({ format: 'A4', printBackground: true });
  } finally {
    await page.close();
  }
}

async function downloadAttachment(gmail, messageId, part) {
  if (part.body.data) {
    return Buffer.from(part.body.data, 'base64url');
  }
  const { data } = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: part.body.attachmentId,
  });
  return Buffer.from(data.data, 'base64url');
}

// dd/mm/yyyy (the format lib/invoice-extractor.js's prompt asks for) -> "YYYY-MM"
function invoiceMonth(dateStr) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((dateStr || '').trim());
  if (!match) return null;
  const [, , mm, yyyy] = match;
  const month = Number(mm);
  if (month < 1 || month > 12) return null;
  return `${yyyy}-${mm}`;
}

// macOS-only, deliberately: `sips` ships with the OS and decodes HEIC
// natively, sidestepping the libheif build/licensing uncertainty around npm
// image libraries. Fine since this script only ever runs locally (launchd).
// execFileSync (not execSync) avoids shell interpolation of the attachment's
// filename, which is attacker-controlled input arriving over email.
function convertHeicToJpeg(srcPath) {
  const destPath = srcPath.replace(/\.(heic|heif)$/i, '.jpg');
  execFileSync('sips', ['-s', 'format', 'jpeg', srcPath, '--out', destPath], { stdio: 'ignore' });
  return destPath;
}

function sanitizeFilename(name) {
  return name.replace(/[/\\]/g, '_');
}

async function fileExists(p) {
  return fs.access(p).then(() => true).catch(() => false);
}

// Avoid clobbering an existing file of the same name (e.g. two different
// senders both attaching "invoice.pdf").
function uniqueName(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = filename;
  let n = 1;
  while (existsSync(path.join(dir, candidate))) {
    candidate = `${base}-${n}${ext}`;
    n += 1;
  }
  return candidate;
}

async function ensureLabel(gmail, labelName) {
  const { data } = await gmail.users.labels.list({ userId: 'me' });
  const existing = data.labels?.find((l) => l.name === labelName);
  if (existing) return existing.id;

  const { data: created } = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name: labelName,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    },
  });
  return created.id;
}

main().catch(async (error) => {
  console.error(`\n❌ poll-inbox failed: ${error.message}\n`);
  // invalid_grant (expired refresh token) lands here, as does anything else
  // that kills the whole run before a single message is looked at.
  await recordFailure(error.message);
  process.exit(1);
});
