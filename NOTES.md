# Development Notes for Future Work

## Current State (January 2026)

This project is **working** but acknowledged as "not perfect" by the developer. It successfully processes monthly invoices with some manual workarounds.

## Recent Additions (December 2025 - January 2026)

### New Features Implemented
1. **Transaction filtering** (`exclusions.txt`) - Exclude bank fees, internal transfers, etc.
2. **Personal expense routing** (`personal-exceptions.txt`) - Auto-route withdrawals and personal charges
3. **Transaction grouping** (`grouping-rules.txt`) - Combine related transactions (e.g., Via Verde tolls)
4. **File attachments in XLSX** - Clickable links to invoice files in the "Ficheiro" column
5. **Export bundle** (`export-bundle.js`) - Package files for accountant delivery
6. **Month setup utility** (`create-month.js`) - Scaffold new month folders

### Configuration Changes
- Token budget increased: 200k → 500k tokens
- Amount tolerance increased: €0.50 → €1.50 (for USD→EUR conversion)
- Date proximity tightened: 7 days → 3 days
- Vendor similarity raised: 0.6 → 0.8 (stricter matching)
- Added USD→EUR conversion rate: 0.95
- Company name: "nitida" (used in export bundle naming)

## Known Issues & Workarounds

*(User mentioned "not perfect but did the job" - these should be documented as you discover them)*

### Potential Areas for Improvement

1. **Currency Conversion**
   - Currently uses fixed USD→EUR rate (0.95)
   - Consider: Dynamic exchange rates or per-invoice conversion notes

2. **Grouping Rules**
   - Only Via Verde implemented
   - Consider: More patterns for recurring charges

3. **Matching Algorithm**
   - Batch size: 30 transactions per AI request
   - Consider: Is this optimal? Test with larger batches

4. **Personal Account "remain" Field**
   - Can be set in `params.yml` as `remain: <amount>`
   - Purpose unclear - document this!

## Files That Need Updates

### Outdated Documentation
- `QUICKSTART.txt` - Missing new scripts and config files
- `DELIVERABLES.md` - Missing new features and updated config values
- `SETUP.md` - Needs verification

### Configuration Files
All filter files support wildcards (`*`) and comments (`#`):
- `exclusions.txt` - Transactions to exclude entirely
- `personal-exceptions.txt` - Route to personal account
- `ignore-words.txt` - Clean vendor names for matching (doesn't affect output)
- `grouping-rules.txt` - Format: `PATTERN → DISPLAY_NAME → INVOICE_MATCH`

## Workflow for Next Month

1. **Setup new month**
   ```bash
   node create-month.js --y=2026 --m=2
   ```

2. **Add data**
   - CSV files → `data/2026-02/inputs/`
   - Invoice photos → `data/2026-02/inputs/paper/`
   - PDF invoices → `data/2026-02/inputs/digital/`

3. **Test CSV parsing** (free)
   ```bash
   node test-local.js --y=2026 --m=2
   ```

4. **Process** (uses OpenAI API)
   ```bash
   node index.js --y=2026 --m=2
   ```

5. **Review output**
   - Check `data/2026-02/out/2026-02.xlsx`
   - Look for yellow-highlighted rows (missing invoices)
   - Verify personal expenses routed correctly

6. **Export for accountant**
   ```bash
   node export-bundle.js --y=2026 --m=2
   ```
   - Output: `data/2026-02/nitida-export-2026-02/`

## Questions for Developer

*(Things to clarify or fix next sprint)*

1. What specific issues occurred this month that required manual fixes?
2. What is the `remain` field in `params.yml` used for?
3. Are there recurring patterns that should be added to filter/grouping files?
4. Should `grouping-rules.txt` have more patterns?
5. Is the USD→EUR conversion rate working correctly?
6. Any vendor names that need cleanup rules in `ignore-words.txt`?

## Before Next Sprint

- [ ] Update QUICKSTART.txt with new scripts
- [ ] Update DELIVERABLES.md with new features
- [ ] Document what "remain" field does
- [ ] Add more examples to filter files based on usage patterns
- [ ] Consider: Should we track which issues occur repeatedly?

## Git Repository Status

**Branch**: master
**Uncommitted changes**: Documentation updates (README, help commands, this file)

Before pushing:
```bash
git status
git add -A
git commit -m "Updated docs and help commands for new features"
git push origin master
```

## Cost History

*(Track monthly costs here)*

- **Month**: Estimated/Actual tokens, USD cost, notes
- Example: 2025-12: ~15k tokens, $0.03, worked well

## Future Enhancements

*(Ideas for when you have more time)*

- [ ] Add npm scripts for common tasks
- [ ] Support multiple company configurations
- [ ] Automatic currency conversion via API
- [ ] Better duplicate detection
- [ ] Machine learning for vendor name normalization
- [ ] Web UI for reviewing matches before finalizing
- [ ] Integration with accounting software APIs
- [ ] Automated email to accountant with export bundle

---

**Last Updated**: 2026-01-18
**Status**: Ready for next month, but improvements planned
