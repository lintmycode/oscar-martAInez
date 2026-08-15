#!/usr/bin/env node

import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { resolvePaths } from './lib/paths.js';

/**
 * Validate and convert images to supported formats (PNG, JPEG, GIF, WEBP)
 * - Detects HEIF/HEIC and converts to JPEG
 * - Validates all images are in supported formats
 * - Reports any problematic files
 *
 * Usage: node validate-images.js --y=2026 --m=1 [--fix]
 */

const SUPPORTED_FORMATS = ['png', 'jpeg', 'jpg', 'gif', 'webp'];

async function main() {
  // Parse CLI args
  const args = process.argv.slice(2);
  let year = null;
  let month = null;
  let autoFix = false;

  for (const arg of args) {
    if (arg.startsWith('--year=') || arg.startsWith('--y=')) {
      year = parseInt(arg.split('=')[1]);
    } else if (arg.startsWith('--month=') || arg.startsWith('--m=')) {
      month = parseInt(arg.split('=')[1]);
    } else if (arg === '--fix') {
      autoFix = true;
    } else if (arg === '--help' || arg === '-h') {
      showHelp();
      process.exit(0);
    }
  }

  if (!year || !month) {
    console.error('\n❌ Error: Missing required arguments\n');
    console.error('Usage: node validate-images.js --year=YYYY --month=MM [--fix]');
    console.error('Example: node validate-images.js --y=2026 --m=1 --fix\n');
    process.exit(1);
  }

  const monthStr = `${year}-${String(month).padStart(2, '0')}`;
  const { paperDir, digitalDir } = resolvePaths(monthStr);

  console.log('\n' + '='.repeat(60));
  console.log('IMAGE VALIDATION');
  console.log('='.repeat(60));
  console.log(`Target month: ${monthStr}`);
  console.log(`Auto-fix: ${autoFix ? 'YES' : 'NO'}\n`);

  // Validate both directories
  const results = {
    paper: await validateDirectory(paperDir, 'Paper', autoFix),
    digital: await validateDirectory(digitalDir, 'Digital', autoFix),
  };

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));

  const totalFiles = results.paper.total + results.digital.total;
  const totalValid = results.paper.valid + results.digital.valid;
  const totalConverted = results.paper.converted + results.digital.converted;
  const totalUnsupported = results.paper.unsupported.length + results.digital.unsupported.length;

  console.log(`Total images:      ${totalFiles}`);
  console.log(`  Valid:           ${totalValid}`);
  console.log(`  Converted:       ${totalConverted}`);
  console.log(`  Unsupported:     ${totalUnsupported}`);

  if (totalUnsupported > 0) {
    console.log('\n⚠️  Unsupported files found:');
    [...results.paper.unsupported, ...results.digital.unsupported].forEach(file => {
      console.log(`  - ${file}`);
    });
    console.log('\nRun with --fix to convert HEIF/HEIC files automatically');
  }

  if (totalConverted > 0) {
    console.log(`\n✅ Converted ${totalConverted} images successfully`);
  }

  if (totalUnsupported === 0) {
    console.log('\n✅ All images are valid!');
  }

  console.log('='.repeat(60) + '\n');
  process.exit(totalUnsupported > 0 ? 1 : 0);
}

async function validateDirectory(dir, label, autoFix) {
  console.log(`\n${label} directory: ${dir}`);
  console.log('-'.repeat(60));

  const result = {
    total: 0,
    valid: 0,
    converted: 0,
    unsupported: [],
  };

  try {
    await fs.access(dir);
  } catch {
    console.log('  Directory does not exist (skipping)');
    return result;
  }

  const files = await fs.readdir(dir);
  const imageFiles = files.filter(f => {
    const ext = path.extname(f).toLowerCase().slice(1);
    // Include common image extensions and HEIF/HEIC
    return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heif', 'heic', 'bmp', 'tiff', 'tif'].includes(ext) ||
           f.match(/\.(png|jpg|jpeg|gif|webp|heif|heic|bmp|tiff?)/i);
  });

  if (imageFiles.length === 0) {
    console.log('  No image files found');
    return result;
  }

  console.log(`  Found ${imageFiles.length} image files\n`);

  for (const file of imageFiles) {
    const filePath = path.join(dir, file);
    result.total++;

    try {
      // Detect file type using macOS 'file' command
      const fileType = execSync(`file -b "${filePath}"`, { encoding: 'utf8' }).toLowerCase();
      const ext = path.extname(file).toLowerCase().slice(1);

      // Check if it's a HEIF/HEIC file
      if (fileType.includes('heif') || fileType.includes('heic') || ext === 'heic' || ext === 'heif') {
        if (autoFix) {
          console.log(`  🔄 Converting: ${file}`);
          const baseName = path.basename(file, path.extname(file));
          const outputPath = path.join(dir, `${baseName}.jpeg`);

          try {
            execSync(`sips -s format jpeg "${filePath}" --out "${outputPath}"`, {
              stdio: 'pipe',
            });

            // Verify conversion worked
            const outputExists = await fs.access(outputPath).then(() => true).catch(() => false);
            if (outputExists) {
              console.log(`     ✓ Created: ${baseName}.jpeg`);
              result.converted++;
              result.valid++;

              // Optionally delete original HEIF file
              // await fs.unlink(filePath);
            } else {
              throw new Error('Conversion failed - output file not created');
            }
          } catch (error) {
            console.log(`     ✗ Failed: ${error.message}`);
            result.unsupported.push(`${label}/${file} (HEIF conversion failed)`);
          }
        } else {
          console.log(`  ⚠️  Unsupported: ${file} (HEIF/HEIC - use --fix to convert)`);
          result.unsupported.push(`${label}/${file} (HEIF/HEIC)`);
        }
        continue;
      }

      // Check if it's a supported format
      if (SUPPORTED_FORMATS.includes(ext) &&
          (fileType.includes('image') || fileType.includes('png') || fileType.includes('jpeg') ||
           fileType.includes('gif') || fileType.includes('webp'))) {
        console.log(`  ✓ Valid: ${file}`);
        result.valid++;
      } else {
        console.log(`  ✗ Unsupported: ${file} (${fileType.split(',')[0]})`);
        result.unsupported.push(`${label}/${file} (${fileType.split(',')[0]})`);
      }

    } catch (error) {
      console.log(`  ✗ Error checking: ${file} (${error.message})`);
      result.unsupported.push(`${label}/${file} (error: ${error.message})`);
    }
  }

  return result;
}

function showHelp() {
  console.log(`
validate-images - Validate and convert invoice images to supported formats

Usage: node validate-images.js --year=YYYY --month=MM [--fix]

Options:
  --year=YYYY, --y=YYYY    Year (e.g., 2026)
  --month=MM, --m=MM       Month (1-12)
  --fix                    Automatically convert HEIF/HEIC to JPEG
  --help, -h               Show this help

Supported formats:
  - PNG
  - JPEG/JPG
  - GIF
  - WEBP

This script will:
  1. Scan inputs/paper/ and inputs/digital/ directories
  2. Detect image file types using the 'file' command
  3. Report unsupported formats (especially HEIF/HEIC from iPhone photos)
  4. Optionally convert HEIF/HEIC to JPEG (with --fix flag)

Examples:
  node validate-images.js --y=2026 --m=1           Check images
  node validate-images.js --y=2026 --m=1 --fix     Convert unsupported images

Note: Conversion requires macOS 'sips' utility
`);
}

main();
