import path from 'path';

/**
 * Resolve the data root directory in priority order:
 * 1. OSCAR_DATA_ROOT env var (set by CLI flag handler before this runs)
 * 2. Fallback: <cwd>/data (preserves existing default behavior)
 */
function getDataRoot() {
  if (process.env.OSCAR_DATA_ROOT) {
    return process.env.OSCAR_DATA_ROOT;
  }
  return path.join(process.cwd(), 'data');
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
  };
}
