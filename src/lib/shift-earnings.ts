import { fromManila, manilaKey, manilaParts, shiftKey } from './payout-week.mjs';
import { supabaseAdmin } from './supabase';

const ALL_TIME_AFTER = '2019-01-01T00:00:00.000Z';
const SHARE = 0.1;
const MONTH_GOAL = 3000;

type ShiftId = 1 | 2 | 3;

type Account = { id: string; username: string; name: string };

type Range = { day: string; shift: ShiftId; endAt?: Date };

type ShiftWrite = {
  month: string;
  username: string;
  name: string;
  day: string;
  shift: ShiftId;
  earnings: number;
  refund: number;
  locked: boolean;
  updated_at: string;
};

/**
 * Money that came in during the window. All-time net already has refunds taken out, so a refund is added back.
 * 100 → refund 10 → 110 earns 20. 100 → refund 10 → 100 earns 10.
 * 100 → refund, ending at 90 after 90 came in, earns 90, not -10.
 */
export function measureShift(beforeMills: number, afterMills: number, salesMills: number) {
  const delta = afterMills - beforeMills;
  const refundMills = Math.max(0, salesMills - delta);
  const earnedMills = Math.max(0, delta + refundMills);
  return { earnings: dollars(earnedMills), refund: dollars(refundMills) };
}

function dollars(mills: number) {
  return Math.round(mills / 10) / 100;
}

function round2(amount: number) {
  return Math.round(amount * 100) / 100;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A day locks on the morning seven days later. Fans have that week to refund. */
export function dayIsOld(day: string, today = manilaKey(new Date())) {
  return shiftKey(day, 7) <= today;
}

function monthOf(day: string) {
  return day.slice(0, 7);
}

function lastDayOfMonth(day: string) {
  const [year, month] = day.split('-').map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

function mondayKey(day: string) {
  const [year, month, date] = day.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  const sinceMonday = weekday === 0 ? 6 : weekday - 1;
  return shiftKey(day, -sinceMonday);
}

function daysInclusive(start: string, end: string) {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  return Math.round((b - a) / 86400000) + 1;
}

export function shiftBeingClosed(slot: number, today: string): { shift: ShiftId; day: string } | null {
  if (slot === 8) return { shift: 1, day: today };
  if (slot === 16) return { shift: 2, day: today };
  if (slot === 0) return { shift: 3, day: shiftKey(today, -1) };
  return null;
}

function shiftBounds(range: Range) {
  const [year, month, date] = range.day.split('-').map(Number);
  const hour = range.shift === 1 ? 0 : range.shift === 2 ? 8 : 16;
  const start = fromManila(year, month, date, hour, 0, 0, 0);
  const naturalEnd = new Date(start.getTime() + 8 * 60 * 60 * 1000);
  const end = range.endAt && range.endAt.getTime() < naturalEnd.getTime() ? range.endAt : naturalEnd;
  return { start, end };
}

function shiftOf(ms: number) {
  const hour = manilaParts(new Date(ms)).hour;
  const shift: ShiftId = hour < 8 ? 1 : hour < 16 ? 2 : 3;
  return `${manilaKey(new Date(ms))}:${shift}`;
}

async function pool<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      await run(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

async function fansly(path: string, attempt = 0): Promise<any> {
  const key = process.env.ONLYFANS_API_KEY || '';
  if (!key) throw new Error('ONLYFANS_API_KEY is not set');
  const response = await fetch(`https://app.onlyfansapi.com${path}`, { headers: { Authorization: `Bearer ${key}` } });
  if ((response.status === 429 || response.status >= 500) && attempt < 4) {
    await sleep(800 * (attempt + 1));
    return fansly(path, attempt + 1);
  }
  if (!response.ok) throw new Error(`Fansly API ${response.status}`);
  return response.json();
}

async function listAccounts(): Promise<Account[]> {
  const listed = await fansly('/api/fansly/accounts');
  return (Array.isArray(listed) ? listed : [])
    .filter((row) => row?.is_authenticated && row.fansly_username)
    .map((row) => ({
      id: String(row.id),
      username: String(row.fansly_username),
      name: String(row.display_name || row.fansly_username),
    }));
}

async function allTimeOnce(accountId: string, beforeIso: string) {
  const stats = await fansly(`/api/fansly/${accountId}/earnings/stats?after=${encodeURIComponent(ALL_TIME_AFTER)}&before=${encodeURIComponent(beforeIso)}`);
  if (!Array.isArray(stats?.data)) throw new Error('all-time earnings came back empty');
  let mills = 0;
  for (const row of stats.data) mills += Number(row?.totalNet) || 0;
  return Math.round(mills);
}

async function allTimeMills(accountId: string, beforeIso: string) {
  const first = await allTimeOnce(accountId, beforeIso);
  if (first > 0) return first;
  await sleep(400);
  return allTimeOnce(accountId, beforeIso);
}

/** Fan payments carry destinationTax 2000. `amount` is already the net that lands in all-time. */
async function salesByShift(accountId: string, startMs: number, endMs: number) {
  const sales = new Map<string, number>();
  let offset = 0;
  for (let page = 0; page < 60; page += 1) {
    const body = await fansly(`/api/fansly/${accountId}/earnings/transactions?limit=100&offset=${offset}`);
    const rows = Array.isArray(body?.data?.data) ? body.data.data : [];
    if (!rows.length) break;
    let oldest = Infinity;
    for (const row of rows) {
      const at = Number(row?.createdAt);
      if (!Number.isFinite(at)) continue;
      oldest = Math.min(oldest, at);
      if (at < startMs || at >= endMs) continue;
      if (Number(row?.destinationTax) !== 2000) continue;
      const amount = Number(row?.amount) || 0;
      if (amount <= 0) continue;
      const key = shiftOf(at);
      sales.set(key, (sales.get(key) || 0) + Math.round(amount));
    }
    offset += rows.length;
    const total = Number(body?.data?.total) || 0;
    if (oldest < startMs || offset >= total || rows.length < 100) break;
  }
  return sales;
}

function db() {
  const client = supabaseAdmin();
  if (!client) throw new Error('Supabase is not configured');
  return client;
}

async function lockedKeys(min: string, max: string) {
  const locked = new Set<string>();
  const client = db();
  for (let from = 0; from < 50000; from += 1000) {
    const { data, error } = await client.from('month_shifts').select('username,day').eq('locked', true).gte('day', min).lte('day', max).range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const row of data || []) locked.add(`${row.username}:${String(row.day).slice(0, 10)}`);
    if (!data || data.length < 1000) break;
  }
  return locked;
}

async function measureRanges(ranges: Range[]) {
  if (!ranges.length) return { written: 0, failures: [] as string[] };
  const days = ranges.map((range) => range.day).sort();
  const locked = await lockedKeys(days[0], days[days.length - 1]);
  const accounts = await listAccounts();
  const failures: string[] = [];
  const shiftRows: ShiftWrite[] = [];
  const recordedAt = new Date().toISOString();
  await pool(accounts, 3, async (account) => {
    const mine = ranges.filter((range) => !locked.has(`${account.username}:${range.day}`));
    if (!mine.length) return;
    try {
      const instants = [...new Set(mine.flatMap((range) => {
        const bounds = shiftBounds(range);
        return [bounds.start.toISOString(), bounds.end.toISOString()];
      }))];
      const points = new Map<string, number>();
      for (const iso of instants) points.set(iso, await allTimeMills(account.id, iso));
      const startMs = Math.min(...mine.map((range) => shiftBounds(range).start.getTime()));
      const endMs = Math.max(...mine.map((range) => shiftBounds(range).end.getTime()));
      let salesFailed = false;
      let sales = new Map<string, number>();
      try {
        sales = await salesByShift(account.id, startMs, endMs);
      } catch (error) {
        salesFailed = true;
        failures.push(`${account.username}: ${error instanceof Error ? error.message : 'sales failed'}`);
      }
      const mineRows: ShiftWrite[] = [];
      for (const range of mine) {
        const bounds = shiftBounds(range);
        const before = points.get(bounds.start.toISOString());
        const after = points.get(bounds.end.toISOString());
        if (before == null || after == null) throw new Error('all-time earnings came back empty');
        if (!after && before > 0) throw new Error('all-time earnings came back empty');
        const sold = sales.get(`${range.day}:${range.shift}`);
        const measured = salesFailed
          ? { earnings: dollars(Math.max(0, after - before)), refund: dollars(Math.max(0, before - after)) }
          : measureShift(before, after, sold || 0);
        mineRows.push({
          month: monthOf(range.day),
          username: account.username,
          name: account.name,
          day: range.day,
          shift: range.shift,
          earnings: measured.earnings,
          refund: measured.refund,
          locked: false,
          updated_at: recordedAt,
        });
      }
      shiftRows.push(...mineRows);
      console.error(`earnings ${account.username} ${mine.length} windows`);
    } catch (error) {
      failures.push(`${account.username}: ${error instanceof Error ? error.message : 'shift read failed'}`);
    }
  });
  if (failures.length) console.error(`Shift earnings: ${failures.slice(0, 8).join('; ')}`);
  if (!shiftRows.length) return { written: 0, failures };
  const client = db();
  for (let index = 0; index < shiftRows.length; index += 400) {
    const { error } = await client.from('month_shifts').upsert(shiftRows.slice(index, index + 400), { onConflict: 'username,day,shift' });
    if (error) throw new Error(error.message);
  }
  await rebuildDays([...new Set(shiftRows.map((row) => row.day))]);
  return { written: shiftRows.length, failures };
}

async function rebuildDays(days: string[]) {
  if (!days.length) return;
  const sorted = [...days].sort();
  const client = db();
  const rows: { username: string; name: string; day: string; shift: number; earnings: number; refund: number; month: string }[] = [];
  for (let from = 0; from < 50000; from += 1000) {
    const { data, error } = await client.from('month_shifts').select('username,name,day,shift,earnings,refund,month').gte('day', sorted[0]).lte('day', sorted[sorted.length - 1]).range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const row of data || []) {
      const day = String(row.day).slice(0, 10);
      if (!days.includes(day)) continue;
      rows.push({
        username: String(row.username),
        name: String(row.name || ''),
        day,
        shift: Number(row.shift),
        earnings: Number(row.earnings) || 0,
        refund: Number(row.refund) || 0,
        month: String(row.month || monthOf(day)),
      });
    }
    if (!data || data.length < 1000) break;
  }
  const recordedAt = new Date().toISOString();
  const daily = new Map<string, { month: string; username: string; name: string; day: string; earnings: number; refund: number }>();
  const agencyShift = new Map<string, { month: string; day: string; shift: number; earnings: number; refund: number }>();
  const agencyDay = new Map<string, { month: string; day: string; earnings: number; refund: number }>();
  for (const row of rows) {
    const userKey = `${row.username}:${row.day}`;
    const user = daily.get(userKey) || { month: row.month, username: row.username, name: row.name, day: row.day, earnings: 0, refund: 0 };
    user.name = row.name || user.name;
    user.earnings = round2(user.earnings + row.earnings);
    user.refund = round2(user.refund + row.refund);
    daily.set(userKey, user);
    const shiftId = `${row.day}:${row.shift}`;
    const shift = agencyShift.get(shiftId) || { month: row.month, day: row.day, shift: row.shift, earnings: 0, refund: 0 };
    shift.earnings = round2(shift.earnings + row.earnings);
    shift.refund = round2(shift.refund + row.refund);
    agencyShift.set(shiftId, shift);
    const day = agencyDay.get(row.day) || { month: row.month, day: row.day, earnings: 0, refund: 0 };
    day.earnings = round2(day.earnings + row.earnings);
    day.refund = round2(day.refund + row.refund);
    agencyDay.set(row.day, day);
  }
  const dailyRows = [...daily.values()].map((row) => ({ ...row, locked: false, updated_at: recordedAt }));
  for (let index = 0; index < dailyRows.length; index += 400) {
    const { error } = await client.from('month_daily').upsert(dailyRows.slice(index, index + 400), { onConflict: 'username,day' });
    if (error) throw new Error(error.message);
  }
  const shiftRows = [...agencyShift.values()].map((row) => ({ ...row, locked: false, updated_at: recordedAt }));
  if (shiftRows.length) {
    const { error } = await client.from('agency_shifts').upsert(shiftRows, { onConflict: 'day,shift' });
    if (error) throw new Error(error.message);
  }
  const dayRows = [...agencyDay.values()].map((row) => ({ ...row, locked: false, updated_at: recordedAt }));
  if (dayRows.length) {
    const { error } = await client.from('agency_days').upsert(dayRows, { onConflict: 'day' });
    if (error) throw new Error(error.message);
  }
  const refunds = dailyRows.filter((row) => row.refund > 0).map((row) => ({
    month: row.month,
    username: row.username,
    name: row.name,
    day: row.day,
    refund: row.refund,
    locked: false,
    updated_at: recordedAt,
  }));
  for (const day of [...new Set(dailyRows.map((row) => row.day))]) {
    const zeros = dailyRows.filter((row) => row.day === day && row.refund <= 0).map((row) => row.username);
    if (!zeros.length) continue;
    const { error } = await client.from('day_refunds').delete().eq('day', day).in('username', zeros);
    if (error) throw new Error(error.message);
  }
  if (refunds.length) {
    const { error } = await client.from('day_refunds').upsert(refunds, { onConflict: 'username,day' });
    if (error) throw new Error(error.message);
  }
}

export async function lockOldDays(now = new Date()) {
  const cutoff = shiftKey(manilaKey(now), -7);
  const client = db();
  for (const table of ['month_shifts', 'month_daily', 'agency_shifts', 'agency_days', 'day_refunds']) {
    const { error } = await client.from(table).update({ locked: true, updated_at: now.toISOString() }).lte('day', cutoff).eq('locked', false);
    if (error) throw new Error(error.message);
  }
  return cutoff;
}

function monthRanges(month: string, now: Date): Range[] {
  const start = `${month}-01`;
  const end = lastDayOfMonth(start);
  const today = manilaKey(now);
  const hour = manilaParts(now).hour;
  const ranges: Range[] = [];
  for (let day = start; day <= end && day <= today; day = shiftKey(day, 1)) {
    const partial = day === today;
    if (!partial || hour >= 8) ranges.push({ day, shift: 1 });
    else ranges.push({ day, shift: 1, endAt: now });
    if (!partial) {
      ranges.push({ day, shift: 2 }, { day, shift: 3 });
      continue;
    }
    if (hour >= 16) {
      ranges.push({ day, shift: 2 }, { day, shift: 3, endAt: now });
    } else if (hour >= 8) {
      ranges.push({ day, shift: 2, endAt: now });
    }
  }
  return ranges;
}

export async function backfillMonth(month: string, now = new Date()) {
  const result = await measureRanges(monthRanges(month, now));
  const cutoff = await lockOldDays(now);
  console.error(`Backfill ${month}: wrote ${result.written} shift rows. Locked through ${cutoff}. Failed: ${result.failures.length}`);
  return result;
}

export async function closeShiftEarnings(slot: number) {
  const now = new Date();
  const today = manilaKey(now);
  const closing = shiftBeingClosed(slot, today);
  if (!closing) return 0;
  const result = await measureRanges([{ day: closing.day, shift: closing.shift }]);
  if (slot === 0) await lockOldDays(now);
  return result.written;
}

/** Refunds can land for a week. This runs after the midnight message, so the text is not waiting on it. */
export async function remeasureRecentEarnings(now = new Date()) {
  const today = manilaKey(now);
  const ranges: Range[] = [];
  for (let day = shiftKey(today, -6); day < today; day = shiftKey(day, 1)) {
    ranges.push({ day, shift: 1 }, { day, shift: 2 }, { day, shift: 3 });
  }
  const result = await measureRanges(ranges);
  await lockOldDays(now);
  return result.written;
}

/** The shift that is open right now, measured up to this minute. Used at 6pm. */
export async function refreshOpenShift(now = new Date()) {
  const today = manilaKey(now);
  const hour = manilaParts(now).hour;
  const shift: ShiftId = hour < 8 ? 1 : hour < 16 ? 2 : 3;
  const result = await measureRanges([{ day: today, shift, endAt: now }]);
  return result.written;
}

export async function ownerFigures(reportDay: string, throughShift: 1 | 2 | 3) {
  const client = db();
  const weekStart = mondayKey(reportDay);
  const monthStart = `${monthOf(reportDay)}-01`;
  const from = weekStart < monthStart ? weekStart : monthStart;
  const { data: span, error } = await client.from('agency_days').select('day,earnings').gte('day', from).lte('day', reportDay);
  if (error) throw new Error(error.message);
  let month = 0;
  let week = 0;
  let dayTotal = 0;
  for (const row of span || []) {
    const day = String(row.day).slice(0, 10);
    const earnings = Number(row.earnings) || 0;
    if (day === reportDay) dayTotal = round2(earnings);
    if (day >= monthStart && day <= reportDay) month = round2(month + earnings);
    if (day >= weekStart && day <= reportDay) week = round2(week + earnings);
  }
  const { data: shifts, error: shiftError } = await client.from('agency_shifts').select('shift,earnings').eq('day', reportDay);
  if (shiftError) throw new Error(shiftError.message);
  const raw = [0, 0, 0];
  for (const row of shifts || []) {
    const index = Number(row.shift) - 1;
    if (index >= 0 && index < 3) raw[index] = round2(Number(row.earnings) || 0);
  }
  const shown = raw.map((amount, index) => (index < throughShift ? amount : 0));
  const hidden = round2(raw.reduce((sum, amount, index) => sum + (index >= throughShift ? amount : 0), 0));
  dayTotal = round2(Math.max(0, dayTotal - hidden));
  week = round2(Math.max(0, week - hidden));
  month = round2(Math.max(0, month - hidden));
  const meWeek = round2(week * SHARE);
  const meMonth = round2(month * SHARE);
  const monthDay = Number(reportDay.slice(8, 10));
  const last = Number(lastDayOfMonth(reportDay).slice(8, 10));
  const dayStillOpen = throughShift < 3;
  const daysLeft = dayStillOpen ? Math.max(0, last - monthDay + 1) : Math.max(0, last - monthDay);
  const goalLeft = round2(Math.max(0, MONTH_GOAL - meMonth));
  return {
    shifts: shown,
    day: dayTotal,
    week,
    meWeek,
    avgWeek: round2(meWeek / Math.max(1, daysInclusive(weekStart, reportDay))),
    month,
    meMonth,
    avgDaily: round2(meMonth / Math.max(1, monthDay)),
    goalLeft,
    need: goalLeft === 0 || daysLeft === 0 ? 0 : round2(goalLeft / daysLeft),
  };
}

export type ModelShiftMoney = { name: string; shifts: [number, number, number] };

/** Every model measured that day. Shifts still open are 0, same as the agency lines. */
export async function modelShiftEarnings(reportDay: string, throughShift: 1 | 2 | 3): Promise<ModelShiftMoney[]> {
  const client = db();
  const rows: { username: string; name: string; shift: number; earnings: number }[] = [];
  for (let from = 0; from < 50000; from += 1000) {
    const { data, error } = await client.from('month_shifts').select('username,name,shift,earnings').eq('day', reportDay).range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const row of data || []) {
      rows.push({
        username: String(row.username || ''),
        name: String(row.name || row.username || ''),
        shift: Number(row.shift),
        earnings: Number(row.earnings) || 0,
      });
    }
    if (!data || data.length < 1000) break;
  }
  const byUser = new Map<string, ModelShiftMoney>();
  for (const row of rows) {
    const key = row.username.toLowerCase();
    const current = byUser.get(key) || { name: row.name, shifts: [0, 0, 0] as [number, number, number] };
    if (row.name) current.name = row.name;
    const index = row.shift - 1;
    if (index >= 0 && index < 3) current.shifts[index] = round2(current.shifts[index] + row.earnings);
    byUser.set(key, current);
  }
  return [...byUser.values()]
    .map((model) => ({
      name: model.name,
      shifts: model.shifts.map((amount, index) => (index < throughShift ? amount : 0)) as [number, number, number],
    }))
    .sort((a, b) => {
      const aTotal = a.shifts[0] + a.shifts[1] + a.shifts[2];
      const bTotal = b.shifts[0] + b.shifts[1] + b.shifts[2];
      return bTotal - aTotal || a.name.localeCompare(b.name);
    });
}
