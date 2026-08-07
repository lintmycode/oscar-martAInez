#!/usr/bin/env node

import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

/**
 * Convert HEIF/HEIC images to JPEG using macOS sips
 * Usage: node convert-heif.js --y=2026 --m=1
 */

// Parse CLI args
const args = process.argv.slice(2);
const yearArg = args.find(a => a.startsWith('--y=') || a.startsWith('--year='));
const monthArg = args.find(a => a.startsWith('--m=') || a.startsWith('--month='));

if (!yearArg || !monthArg) {
  console.error('Usage: node convert-heif.js --y=YYYY --m=MM');
  process.exit(1);
}

const year = parseInt(yearArg.split('=')[1]);
const month = parseInt(monthArg.split('=')[1]);
const monthDir = `data/${year}-${String(month).padStart(2, '0')}`;
const paperDir = path.join(monthDir, 'inputs', 'paper');

console.log(`\nConverting HEIF images in ${paperDir}...\n`);

try {
  const files = await fs.readdir(paperDir);
  let converted = 0;

  for (const file of files) {
    const filePath = path.join(paperDir, file);

    // Check if it's a HEIF file
    try {
      const fileType = execSync(`file "${filePath}"`, { encoding: 'utf8' });

      if (fileType.includes('HEIF') || fileType.includes('HEIC')) {
        const ext = path.extname(file);
        const baseName = path.basename(file, ext);
        const outputPath = path.join(paperDir, `${baseName}_converted.jpeg`);

        console.log(`Converting: ${file} -> ${baseName}_converted.jpeg`);

        execSync(`sips -s format jpeg "${filePath}" --out "${outputPath}"`, {
          stdio: 'inherit'
        });

        converted++;
      }
    } catch (error) {
      // Skip non-image files
      continue;
    }
  }

  console.log(`\n✓ Converted ${converted} HEIF images to JPEG`);

  if (converted === 0) {
    console.log('  No HEIF images found');
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
