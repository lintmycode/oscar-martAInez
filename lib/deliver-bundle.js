// STUB - placeholder for U4 (bundle delivery), which is built in another
// worktree. Only here so the close job (close-month.js) can be coded and
// tested against the agreed interface. Drop this file at merge time in
// favour of the real lib/deliver-bundle.js.
//
// Interface (agreed with U4):
//   deliverBundle({ month, incomplete = false, missing = [], summary = null })
//   -> { zipPath, zipBytes, emailed, attached }; honours OSCAR_DRY_RUN=1
export async function deliverBundle({ month, incomplete = false, missing = [], summary = null }) {
  console.log('[deliver-bundle STUB]', JSON.stringify({ month, incomplete, missing, summary }, null, 2));
  return { emailed: false };
}
