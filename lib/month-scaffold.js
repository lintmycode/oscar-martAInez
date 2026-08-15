import fs from 'fs/promises';
import { resolvePaths } from './paths.js';

/**
 * Create (if missing) the folder structure + default params.yml for a month.
 * Shared by create-month.js (manual) and poll-inbox.js (auto-filing arrivals
 * for a month nobody has scaffolded yet).
 */
export async function ensureMonthScaffold(monthStr) {
  const paths = resolvePaths(monthStr);

  await fs.mkdir(paths.paperDir, { recursive: true });
  await fs.mkdir(paths.digitalDir, { recursive: true });
  await fs.mkdir(paths.outDir, { recursive: true });
  await ensureParams(paths.paramsPath, monthStr);

  return paths;
}

async function ensureParams(paramsPath, monthStr) {
  try {
    await fs.access(paramsPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const [year, month] = monthStr.split('-').map(Number);
    await fs.writeFile(paramsPath, `year: ${year}\nmonth: ${month}\n`);
  }
}
