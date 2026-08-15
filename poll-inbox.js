#!/usr/bin/env node
// Polls the dedicated invoice-intake Gmail account for new unread emails
// with attachments (or forwarded HTML-only receipts, rendered to PDF here -
// the automated version of "save email as PDF"), figures out which month
// each invoice/receipt belongs to (reusing the same date-extraction the
// monthly run uses), and files them straight into
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
  const auth = await getOAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const openai = new OpenAI({ apiKey: CONFIG.openai.apiKey });
  const extractor = new InvoiceExtractor(openai, new TokenTracker());

  const processedLabelId = await ensureLabel(gmail, PROCESSED_LABEL);
  const needsReviewDir = path.join(getDataRoot(), 'tmp', 'needs-review');
  const subjectWhitelist = await loadSubjectWhitelist();

  const list = await gmail.users.messages.list({ userId: 'me', q: QUERY, maxResults: 50 });
  const messages = list.data.messages || [];

  if (!messages.length) {
    console.log('No new invoice emails.');
    return;
  }

  console.log(`Found ${messages.length} unread candidate message(s).`);

  // Lazily launched only if some message actually needs HTML->PDF rendering,
  // and shared across messages in this run rather than one launch each.
  const browserRef = { current: null };
  try {
    for (const { id: messageId } of messages) {
      await processMessage({ gmail, messageId, extractor, processedLabelId, needsReviewDir, browserRef, subjectWhitelist });
    }
  } finally {
    if (browserRef.current) await browserRef.current.close();
  }
}

async function processMessage({ gmail, messageId, extractor, processedLabelId, needsReviewDir, browserRef, subjectWhitelist }) {
  const { data: message } = await gmail.users.messages.get({ userId: 'me', id: messageId });
  const subject = headerValue(message.payload, 'Subject') || '(no subject)';

  let candidates = collectAttachmentParts(message.payload)
    .filter((p) => SUPPORTED_EXT.has(path.extname(p.filename || '').toLowerCase()))
    .map((part) => ({
      filename: part.filename,
      ext: path.extname(part.filename).toLowerCase(),
      getBuffer: () => downloadAttachment(gmail, messageId, part),
    }));

  // No real attachment - only render+extract an HTML body if the subject is
  // explicitly whitelisted (email-invoice-subjects.txt). This is the access
  // control: without it, any "fwd"/"fw" subject would trigger rendering.
  if (!candidates.length) {
    const strippedSubject = stripSubjectPrefixes(subject);
    if (!matchesWhitelist(strippedSubject, subjectWhitelist)) {
      console.log(`Skipping "${subject}": no pdf/jpg/png/heic attachment, and subject isn't in email-invoice-subjects.txt.`);
      return;
    }

    const htmlPart = findHtmlPart(message.payload);
    if (htmlPart) {
      const html = Buffer.from(htmlPart.body.data, 'base64url').toString('utf8');
      candidates = [{
        filename: `${slugify(strippedSubject)}.pdf`,
        ext: '.pdf',
        getBuffer: async () => {
          browserRef.current = browserRef.current || (await launchBrowser());
          return renderHtmlToPdf(browserRef.current, html);
        },
      }];
    }
  }

  if (!candidates.length) {
    console.log(`Skipping "${subject}": no pdf/jpg/png/heic attachment or HTML body found, left unread for manual look.`);
    return;
  }

  let filedCount = 0;

  for (const candidate of candidates) {
    const filed = await fileCandidate({ candidate, extractor, needsReviewDir, subject });
    if (filed) filedCount += 1;
  }

  if (filedCount > 0) {
    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { removeLabelIds: ['UNREAD'], addLabelIds: [processedLabelId] },
    });
  }
}

async function fileCandidate({ candidate, extractor, needsReviewDir, subject }) {
  const { ext } = candidate;
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

  const monthStr = invoiceMonth(invoice?.date);

  if (!monthStr) {
    await fs.mkdir(needsReviewDir, { recursive: true });
    const destPath = path.join(needsReviewDir, uniqueName(needsReviewDir, filedFilename));
    await fs.rename(workingPath, destPath);
    console.log(
      `FLAG: could not determine an invoice date for "${filedFilename}" (from "${subject}") - left at ${destPath} for manual review.`
    );
    return false;
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
  return true;
}

function headerValue(payload, name) {
  return payload?.headers?.find((h) => h.name === name)?.value || null;
}

function collectAttachmentParts(payload, acc = []) {
  if (!payload) return acc;
  if (payload.filename && payload.body && (payload.body.attachmentId || payload.body.data)) {
    acc.push(payload);
  }
  if (payload.parts) {
    for (const part of payload.parts) collectAttachmentParts(part, acc);
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

main().catch((error) => {
  console.error(`\n❌ poll-inbox failed: ${error.message}\n`);
  process.exit(1);
});
