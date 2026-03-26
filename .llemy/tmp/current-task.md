# Todo: lintmycode/oscar-martAInez#1
# Detach data directory from repo and support external echo.ops path

## Tasks

- [ ] **Create `lib/paths.js`** — centralized path resolver module
  - Export a `resolvePaths(monthStr)` function that returns all paths (`monthDir`, `inputsDir`, `paperDir`, `digitalDir`, `outDir`, `paramsPath`, `xlsxPath`)
  - Determine `dataRoot` by checking, in priority order:
    1. `--data-root <path>` CLI flag (parsed before calling resolver)
    2. `OSCAR_DATA_ROOT` env var
    3. Fallback: `path.join(process.cwd(), 'data')` (current default, preserves existing behavior)
  - Also export `resolveConfigPaths()` for root-level rule files (`exclusions.txt`, `personal-exceptions.txt`, `ignore-words.txt`, `grouping-rules.txt`) — these stay relative to `process.cwd()` (they are code config, not data)

- [ ] **Update `index.js`**
  - Parse `--data-root` CLI flag (before month argument handling)
  - Set `OSCAR_DATA_ROOT` from flag if provided (so `lib/paths.js` picks it up)
  - Replace hardcoded `path.join(process.cwd(), 'data', monthStr)` block (lines 32–34, 52, 81, 96, 102, 108, 124–125, 144) with calls to `resolvePaths()` and `resolveConfigPaths()`

- [ ] **Update `create-month.js`**
  - Parse `--data-root` CLI flag
  - Replace hardcoded path block (lines 13–17, 23) with `resolvePaths()`

- [ ] **Update `export-bundle.js`**
  - Parse `--data-root` CLI flag
  - Replace hardcoded path block (lines 14–16, 19, 26–27, 42, 45, 49) with `resolvePaths()`

- [ ] **Update `test-local.js`**
  - Replace hardcoded path block (lines 36–38, 49, 55, 79) with `resolvePaths()` and `resolveConfigPaths()`

- [ ] **Update `README.md`**
  - Document `--data-root` flag and `OSCAR_DATA_ROOT` env var with examples
  - Show example usage with `/mnt/echo-ops/tmp/data` as external path
  - Clarify that default behavior (local `data/`) is unchanged when neither flag nor env var is set

## Notes

- `lib/invoice-extractor.js`, `lib/transaction-extractor.js`, and `lib/xlsx-generator.js` receive directory paths as arguments from `index.js` — they do **not** need to change, path resolution stays at the caller level
- The export bundle output folder (`nitida-export-YYYY-MM/`) should remain under the resolved `monthDir`, not hardcoded to repo root
- Do not remove `.gitignore` entries for `data/` — the fallback local data directory should still be ignored by git
