import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import sharp from 'sharp';
import { CONFIG } from '../config.js';
import { resolvePaths, getDataRoot } from './paths.js';

// Photo shrinking applies to the bundle COPY only; originals in inputs/ are
// never touched (the extractor and any re-export need the full-resolution
// files). Gmail caps a message at 25 MB and June 2026's zip was 26.8 MB of
// phone photos; 2000 px on the long edge at JPEG q85 is still fully legible
// for invoices and cuts the zip several-fold.
const MAX_EDGE = 2000;
const JPEG_QUALITY = 85;
const SHRINKABLE = new Set(['.jpg', '.jpeg', '.png']);

export function sanitizeName(name) {
  return name
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'company';
}

/**
 * Build the accountant bundle (folder + zip) for a month.
 * @param {string} monthStr - 'YYYY-MM'
 * @param {{shrinkPhotos?: boolean}} [opts]
 * @returns {Promise<{zipPath: string, zipBytes: number, fileCount: number, exportDir: string}>}
 */
export async function buildBundle(monthStr, { shrinkPhotos = true } = {}) {
  const { monthDir, inputsDir, xlsxPath } = resolvePaths(monthStr);
  const companyName = sanitizeName(CONFIG.company?.name || 'company');
  const exportFolderName = `${companyName}-export-${monthStr}`;

  // Export bundle lives inside monthDir (which may be an external data root)
  const exportDir = path.join(monthDir, exportFolderName);

  // Rebuild from scratch: copying over an old export left files that had
  // since been moved/removed from inputs/ (e.g. a re-filed invoice) in the
  // folder, and from there in the zip. Both are generated, never edited.
  await fs.rm(exportDir, { recursive: true, force: true });
  await fs.mkdir(exportDir, { recursive: true });

  const copied = await copyInputsStructured(inputsDir, exportDir, shrinkPhotos);

  const exportXlsxName = `${companyName}-${monthStr}.xlsx`;
  const hasXlsx = await copyIfExists(xlsxPath, path.join(exportDir, exportXlsxName));

  console.log(`\nExported ${copied} input files + ${exportXlsxName} to ${exportDir}/`);

  // Create zip file in <data root>/bundles/
  const bundlesDir = path.join(getDataRoot(), 'bundles');
  await fs.mkdir(bundlesDir, { recursive: true });

  const zipName = `${exportFolderName}.zip`;
  const zipPath = path.join(bundlesDir, zipName);

  console.log(`\nCreating zip archive...`);

  // `zip -r` adds to an existing archive instead of replacing it, so stale
  // entries would survive - start from an empty one.
  await fs.rm(zipPath, { force: true });

  // cd into monthDir to avoid the full path inside the zip
  try {
    execSync(`cd "${monthDir}" && zip -r "${zipPath}" "${exportFolderName}" -q`, { stdio: 'pipe' });
  } catch (error) {
    throw new Error(`Failed to create zip: ${error.message} (unzipped bundle at ${exportDir}/)`);
  }

  const stats = await fs.stat(zipPath);
  console.log(`✓ Created ${zipName} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`\nBundle saved to: ${zipPath}`);

  return { zipPath, zipBytes: stats.size, fileCount: copied + (hasXlsx ? 1 : 0), exportDir };
}

/**
 * Write a shrunk JPEG copy of a photo (<= MAX_EDGE px, q85). PNGs become
 * .jpg. If re-encoding would not make the file smaller (already small), the
 * original bytes are copied instead.
 */
async function shrinkPhoto(srcPath, destPath) {
  const ext = path.extname(destPath);
  const jpgDest = ext.toLowerCase() === '.png' ? destPath.slice(0, -ext.length) + '.jpg' : destPath;
  // rotate() with no args applies the EXIF orientation, then the tag is
  // dropped from the output, so the pixels stay upright for every viewer.
  const buf = await sharp(srcPath)
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }) // PNG transparency -> white, not black
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
  const origSize = (await fs.stat(srcPath)).size;
  if (buf.length < origSize || ext.toLowerCase() === '.png') {
    await fs.writeFile(jpgDest, buf);
  } else {
    await fs.copyFile(srcPath, destPath);
  }
}

async function copyInputsStructured(inputsDir, exportDir, shrinkPhotos) {
  let count = 0;
  const entries = await fs.readdir(inputsDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(inputsDir, entry.name);

    // Copy CSV files and paper/digital directories
    if (entry.isFile()) {
      if (path.extname(entry.name).toLowerCase() === '.json') continue; // Skip JSON cache
      if (path.extname(entry.name).toLowerCase() === '.csv') {
        const destPath = path.join(exportDir, entry.name);
        await fs.copyFile(srcPath, destPath);
        count += 1;
      }
    } else if (entry.isDirectory() && (entry.name === 'paper' || entry.name === 'digital')) {
      const destDir = path.join(exportDir, entry.name);
      count += await copyDirectory(srcPath, destDir, shrinkPhotos, entry.name === 'paper');
    }
  }

  return count;
}

async function copyDirectory(srcDir, destDir, shrinkPhotos, isPaper) {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  let count = 0;

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      count += await copyDirectory(srcPath, destPath, shrinkPhotos, isPaper);
    } else if (entry.isFile()) {
      if (path.extname(entry.name).toLowerCase() === '.json') continue;
      if (shrinkPhotos && isPaper && SHRINKABLE.has(path.extname(entry.name).toLowerCase())) {
        await shrinkPhoto(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
      count += 1;
    }
  }

  return count;
}

async function copyIfExists(src, dest) {
  try {
    await fs.copyFile(src, dest);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn(`\n⚠️  XLSX not found at ${src}`);
      return false;
    }
    throw error;
  }
}

