// Loaded here (not just in index.js) so every script that resolves data
// paths - create-month.js, export-bundle.js, test-local.js included - picks
// up OSCAR_DATA_ROOT from .env. dotenv never overrides a variable that is
// already set, and the --data-root flag handlers assign process.env after
// imports run, so the flag still wins.
import 'dotenv/config';
import path from 'path';
import { existsSync } from 'fs';

/**
 * Resolve the data root directory in priority order:
 * 1. --data-root=<path> CLI flag (copied into OSCAR_DATA_ROOT by each script)
 * 2. OSCAR_DATA_ROOT env var / .env - per machine, since the shared NAS
 *    folder mounts at /Volumes/echo.ops/oscar on the laptop and
 *    /mnt/echo-ops/oscar on echo
 * 3. Fallback: <cwd>/data (preserves existing default behavior)
 */
export function getDataRoot() {
  const configured = process.env.OSCAR_DATA_ROOT;
  if (!configured) {
    return path.join(process.cwd(), 'data');
  }
  // An explicitly configured root that doesn't exist almost always means
  // the NAS share isn't mounted (laptop asleep/off the LAN, autofs not up).
  // Fail loudly rather than let a recursive mkdir quietly create a stray
  // local /Volumes/echo.ops/... tree that nobody else can see.
  if (!existsSync(configured)) {
    throw new Error(
      `data root ${configured} not found - is the echo.ops share mounted?`
    );
  }
  return configured;
}

/**
 * Resolve all month-scoped data paths.
 * @param {string} monthStr - e.g. "2025-10"
 */
export function resolvePaths(monthStr) {
  const dataRoot = getDataRoot();
  const monthDir = path.join(dataRoot, monthStr);
  const inputsDir = path.join(monthDir, 'inputs');
  const paperDir = path.join(inputsDir, 'paper');
  const digitalDir = path.join(inputsDir, 'digital');
  const outDir = path.join(monthDir, 'out');
  const paramsPath = path.join(monthDir, 'params.yml');
  const xlsxPath = path.join(outDir, `${monthStr}.xlsx`);

  return { monthDir, inputsDir, paperDir, digitalDir, outDir, paramsPath, xlsxPath };
}

/**
 * Resolve paths for root-level rule/config files.
 * These are code config (not data), so they stay relative to cwd.
 */
export function resolveConfigPaths() {
  const cwd = process.cwd();
  return {
    exclusionsFile: path.join(cwd, 'exclusions.txt'),
    personalExceptionsFile: path.join(cwd, 'personal-exceptions.txt'),
    ignoreWordsFile: path.join(cwd, 'ignore-words.txt'),
    groupingFile: path.join(cwd, 'grouping-rules.txt'),
    transactionNotesFile: path.join(cwd, 'transaction-notes.txt'),
  };
}
