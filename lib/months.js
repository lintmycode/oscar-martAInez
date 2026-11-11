// Small "YYYY-MM" helpers shared by the extract classifier, month status and
// the close job. Months are plain strings everywhere ("2026-10").

export function parseMonth(str) {
  const m = /^(\d{4})-(\d{2})$/.exec(str || '');
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new Error(`Invalid month "${str}" (expected YYYY-MM)`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

export function fmtMonth(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function addMonths(str, n) {
  const { year, month } = parseMonth(str);
  const idx = year * 12 + (month - 1) + n;
  return fmtMonth(Math.floor(idx / 12), (idx % 12) + 1);
}

export function lastDayOfMonth(str) {
  const { year, month } = parseMonth(str);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthNameEn = (str) => `${EN_MONTHS[parseMonth(str).month - 1]} ${parseMonth(str).year}`;

// "Today" in Lisbon as {year, month, day, iso}. Cron on echo runs in UTC, but
// the close schedule (14th / 20th) is defined in Lisbon dates.
// OSCAR_TODAY=YYYY-MM-DD overrides it for testing.
export function today() {
  const override = process.env.OSCAR_TODAY;
  if (override) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(override);
    if (!m) throw new Error(`OSCAR_TODAY must be YYYY-MM-DD, got "${override}"`);
    return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), iso: override };
  }
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon' }).format(new Date());
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day, iso };
}
