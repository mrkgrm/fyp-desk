/** Philippine time is UTC+8 all year. Payroll cuts on that clock, not on UTC days. */

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function manilaParts(instant) {
  const shifted = new Date(instant.getTime() + MANILA_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(),
  };
}

export function manilaKey(instant) {
  const p = manilaParts(instant);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function fromManila(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms) - MANILA_OFFSET_MS);
}

export function addCalendarDays(year, month, day, days) {
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

export function shiftKey(key, days) {
  const [year, month, day] = key.split('-').map(Number);
  const next = addCalendarDays(year, month, day, days);
  return `${next.year}-${String(next.month).padStart(2, '0')}-${String(next.day).padStart(2, '0')}`;
}

export function formatManilaDate(year, month, day) {
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday} ${day} ${MONTHS[month - 1]} ${year}`;
}

export function formatManilaInstant(instant) {
  const p = manilaParts(instant);
  const hour12 = p.hour % 12 || 12;
  const suffix = p.hour < 12 ? 'AM' : 'PM';
  const minute = String(p.minute).padStart(2, '0');
  return `${formatManilaDate(p.year, p.month, p.day)}, ${hour12}:${minute} ${suffix}`;
}

/**
 * Payout Monday pays the Mon–Sun week that ended 8 days earlier.
 * Saturday 17 Oct 2026 → Monday 19 Oct pays 5 Oct 00:00 through 11 Oct 23:59 PH.
 * On payout Monday itself, that same older week is still the one being paid.
 */
export function payoutFor(now = new Date()) {
  const p = manilaParts(now);
  const daysUntilMonday = p.weekday === 1 ? 0 : (8 - p.weekday) % 7;
  const payoutDate = addCalendarDays(p.year, p.month, p.day, daysUntilMonday);
  const startDate = addCalendarDays(payoutDate.year, payoutDate.month, payoutDate.day, -14);
  const endDate = addCalendarDays(payoutDate.year, payoutDate.month, payoutDate.day, -8);
  const start = fromManila(startDate.year, startDate.month, startDate.day, 0, 0, 0, 0);
  const end = fromManila(endDate.year, endDate.month, endDate.day, 23, 59, 59, 999);
  const payoutMonday = fromManila(payoutDate.year, payoutDate.month, payoutDate.day, 0, 0, 0, 0);
  const startKey = `${startDate.year}-${String(startDate.month).padStart(2, '0')}-${String(startDate.day).padStart(2, '0')}`;
  const endKey = `${endDate.year}-${String(endDate.month).padStart(2, '0')}-${String(endDate.day).padStart(2, '0')}`;
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    payoutMonday: payoutMonday.toISOString(),
    startKey,
    endKey,
    label: `${formatManilaDate(payoutDate.year, payoutDate.month, payoutDate.day)} pays ${formatManilaDate(startDate.year, startDate.month, startDate.day)}, 12:00 AM through ${formatManilaDate(endDate.year, endDate.month, endDate.day)}, 11:59 PM, Philippine time`,
  };
}

export function inInstantRange(iso, startIso, endIso) {
  const t = new Date(iso).getTime();
  return t >= new Date(startIso).getTime() && t <= new Date(endIso).getTime();
}
