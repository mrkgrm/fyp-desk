import { fromManila, manilaKey, manilaParts, shiftKey } from './payout-week.mjs';
import { dayIsOld, shiftBeingClosed } from './shift-earnings';
import { supabaseAdmin } from './supabase';

type ShiftId = 1 | 2 | 3;

type Account = { id: string; username: string; name: string };

type Range = { day: string; shift: ShiftId };

type ShiftWrite = {
  month: string;
  username: string;
  name: string;
  day: string;
  shift: ShiftId;
  subs: number;
  locked: boolean;
  updated_at: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function shiftStartMs(day: string, shift: ShiftId) {
  const [year, month, date] = day.split('-').map(Number);
  const hour = shift === 1 ? 0 : shift === 2 ? 8 : 16;
  return fromManila(year, month, date, hour, 0, 0, 0).getTime();
}

function place(ms: number) {
  const day = manilaKey(new Date(ms));
  const hour = manilaParts(new Date(ms)).hour;
  const shift: ShiftId = hour < 8 ? 1 : hour < 16 ? 2 : 3;
  return { day, shift };
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

function unixMs(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
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

/** Subscription periods that started at or after sinceMs. Active and already-expired lists. */
async function periodStarts(accountId: string, sinceMs: number) {
  const starts: number[] = [];
  const seen = new Set<string>();
  for (const status of ['', 'expired']) {
    let path = `/api/fansly/${accountId}/subscribers?limit=100${status ? `&status=${status}` : ''}`;
    for (let page = 0; page < 40; page += 1) {
      const body = await fansly(path);
      const list = Array.isArray(body?.data?.subscriptions) ? body.data.subscriptions : [];
      if (!list.length) break;
      let newestStart = 0;
      let oldestStart = Infinity;
      let newestEnd = 0;
      for (const row of list) {
        const at = unixMs(row?.createdAt);
        const ends = unixMs(row?.endsAt) || 0;
        if (at == null) continue;
        newestStart = Math.max(newestStart, at);
        oldestStart = Math.min(oldestStart, at);
        newestEnd = Math.max(newestEnd, ends);
        if (at < sinceMs) continue;
        const id = String(row.id || row.historyId || `${row.subscriberId}:${at}`);
        if (seen.has(id)) continue;
        seen.add(id);
        starts.push(at);
      }
      const next = body?._pagination?.next_page;
      const done = status
        ? newestEnd < sinceMs || newestStart < sinceMs
        : oldestStart < sinceMs;
      if (done || !body?.data?.hasMore || typeof next !== 'string') break;
      path = next.replace('https://app.onlyfansapi.com', '').replace('https://api.onlyfansapi.com', '');
    }
  }
  return starts;
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
    const { data, error } = await client.from('sub_shifts').select('username,day').eq('locked', true).gte('day', min).lte('day', max).range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const row of data || []) locked.add(`${row.username}:${String(row.day).slice(0, 10)}`);
    if (!data || data.length < 1000) break;
  }
  return locked;
}

function monthRanges(month: string, now: Date): Range[] {
  const start = `${month}-01`;
  const end = lastDayOfMonth(start);
  const today = manilaKey(now);
  const hour = manilaParts(now).hour;
  const ranges: Range[] = [];
  for (let day = start; day <= end && day <= today; day = shiftKey(day, 1)) {
    const partial = day === today;
    if (!partial || hour >= 0) ranges.push({ day, shift: 1 });
    if (!partial) {
      ranges.push({ day, shift: 2 }, { day, shift: 3 });
      continue;
    }
    if (hour >= 8) ranges.push({ day, shift: 2 });
    if (hour >= 16) ranges.push({ day, shift: 3 });
  }
  return ranges;
}

async function writeRanges(ranges: Range[], now = new Date()) {
  if (!ranges.length) return { written: 0, failures: [] as string[] };
  const days = ranges.map((range) => range.day).sort();
  const locked = await lockedKeys(days[0], days[days.length - 1]);
  const sinceMs = Math.min(...ranges.map((range) => shiftStartMs(range.day, range.shift)));
  const untilMs = now.getTime();
  const accounts = await listAccounts();
  const failures: string[] = [];
  const shiftRows: ShiftWrite[] = [];
  const recordedAt = now.toISOString();
  await pool(accounts, 3, async (account) => {
    const mine = ranges.filter((range) => !locked.has(`${account.username}:${range.day}`));
    if (!mine.length) return;
    try {
      const starts = await periodStarts(account.id, sinceMs);
      const counts = new Map<string, number>();
      for (const at of starts) {
        if (at >= untilMs) continue;
        const placed = place(at);
        const key = `${placed.day}:${placed.shift}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      for (const range of mine) {
        shiftRows.push({
          month: monthOf(range.day),
          username: account.username,
          name: account.name,
          day: range.day,
          shift: range.shift,
          subs: counts.get(`${range.day}:${range.shift}`) || 0,
          locked: false,
          updated_at: recordedAt,
        });
      }
      console.error(`subs ${account.username} ${starts.length} starts`);
    } catch (error) {
      failures.push(`${account.username}: ${error instanceof Error ? error.message : 'subs failed'}`);
    }
  });
  if (failures.length) console.error(`Subs: ${failures.slice(0, 8).join('; ')}`);
  if (!shiftRows.length) return { written: 0, failures };
  const client = db();
  for (let index = 0; index < shiftRows.length; index += 400) {
    const { error } = await client.from('sub_shifts').upsert(shiftRows.slice(index, index + 400), { onConflict: 'username,day,shift' });
    if (error) throw new Error(error.message);
  }
  await rebuildDays([...new Set(shiftRows.map((row) => row.day))]);
  return { written: shiftRows.length, failures };
}

async function rebuildDays(days: string[]) {
  if (!days.length) return;
  const sorted = [...days].sort();
  const client = db();
  const rows: { username: string; name: string; day: string; shift: number; subs: number; month: string }[] = [];
  for (let from = 0; from < 50000; from += 1000) {
    const { data, error } = await client.from('sub_shifts').select('username,name,day,shift,subs,month').gte('day', sorted[0]).lte('day', sorted[sorted.length - 1]).range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const row of data || []) {
      const day = String(row.day).slice(0, 10);
      if (!days.includes(day)) continue;
      rows.push({
        username: String(row.username),
        name: String(row.name || ''),
        day,
        shift: Number(row.shift),
        subs: Number(row.subs) || 0,
        month: String(row.month || monthOf(day)),
      });
    }
    if (!data || data.length < 1000) break;
  }
  const recordedAt = new Date().toISOString();
  const daily = new Map<string, { month: string; username: string; name: string; day: string; subs: number }>();
  const agencyShift = new Map<string, { month: string; day: string; shift: number; subs: number }>();
  const agencyDay = new Map<string, { month: string; day: string; subs: number }>();
  for (const row of rows) {
    const userKey = `${row.username}:${row.day}`;
    const user = daily.get(userKey) || { month: row.month, username: row.username, name: row.name, day: row.day, subs: 0 };
    user.name = row.name || user.name;
    user.subs += row.subs;
    daily.set(userKey, user);
    const shiftId = `${row.day}:${row.shift}`;
    const shift = agencyShift.get(shiftId) || { month: row.month, day: row.day, shift: row.shift, subs: 0 };
    shift.subs += row.subs;
    agencyShift.set(shiftId, shift);
    const day = agencyDay.get(row.day) || { month: row.month, day: row.day, subs: 0 };
    day.subs += row.subs;
    agencyDay.set(row.day, day);
  }
  const dailyRows = [...daily.values()].map((row) => ({ ...row, locked: false, updated_at: recordedAt }));
  for (let index = 0; index < dailyRows.length; index += 400) {
    const { error } = await client.from('sub_daily').upsert(dailyRows.slice(index, index + 400), { onConflict: 'username,day' });
    if (error) throw new Error(error.message);
  }
  const shiftRows = [...agencyShift.values()].map((row) => ({ ...row, locked: false, updated_at: recordedAt }));
  if (shiftRows.length) {
    const { error } = await client.from('agency_sub_shifts').upsert(shiftRows, { onConflict: 'day,shift' });
    if (error) throw new Error(error.message);
  }
  const dayRows = [...agencyDay.values()].map((row) => ({ ...row, locked: false, updated_at: recordedAt }));
  if (dayRows.length) {
    const { error } = await client.from('agency_sub_days').upsert(dayRows, { onConflict: 'day' });
    if (error) throw new Error(error.message);
  }
}

export async function lockOldSubs(now = new Date()) {
  const cutoff = shiftKey(manilaKey(now), -7);
  const client = db();
  for (const table of ['sub_shifts', 'sub_daily', 'agency_sub_shifts', 'agency_sub_days']) {
    const { error } = await client.from(table).update({ locked: true, updated_at: now.toISOString() }).lte('day', cutoff).eq('locked', false);
    if (error) throw new Error(error.message);
  }
  return cutoff;
}

export async function backfillSubs(month: string, now = new Date()) {
  const result = await writeRanges(monthRanges(month, now), now);
  const cutoff = await lockOldSubs(now);
  console.error(`Subs ${month}: wrote ${result.written} shift rows. Locked through ${cutoff}. Failed: ${result.failures.length}`);
  return result;
}

export async function closeShiftSubs(slot: number, now = new Date()) {
  const today = manilaKey(now);
  const closing = shiftBeingClosed(slot, today);
  if (!closing || dayIsOld(closing.day, today)) return 0;
  const result = await writeRanges([{ day: closing.day, shift: closing.shift }], now);
  if (slot === 0) await lockOldSubs(now);
  return result.written;
}

export async function subsFigures(reportDay: string) {
  const client = db();
  const weekStart = mondayKey(reportDay);
  const monthStart = `${monthOf(reportDay)}-01`;
  const from = weekStart < monthStart ? weekStart : monthStart;
  const { data: span, error } = await client.from('agency_sub_days').select('day,subs').gte('day', from).lte('day', reportDay);
  if (error) throw new Error(error.message);
  let month = 0;
  let week = 0;
  let dayTotal = 0;
  for (const row of span || []) {
    const day = String(row.day).slice(0, 10);
    const subs = Number(row.subs) || 0;
    if (day === reportDay) dayTotal = subs;
    if (day >= monthStart && day <= reportDay) month += subs;
    if (day >= weekStart && day <= reportDay) week += subs;
  }
  const { data: shifts, error: shiftError } = await client.from('agency_sub_shifts').select('shift,subs').eq('day', reportDay);
  if (shiftError) throw new Error(shiftError.message);
  const shiftSubs = [0, 0, 0];
  for (const row of shifts || []) {
    const index = Number(row.shift) - 1;
    if (index >= 0 && index < 3) shiftSubs[index] = Number(row.subs) || 0;
  }
  const { data: models, error: modelError } = await client.from('sub_daily').select('name,username,subs').eq('day', reportDay).gt('subs', 0).order('subs', { ascending: false });
  if (modelError) throw new Error(modelError.message);
  const people = (models || []).map((row) => ({
    name: String(row.name || row.username),
    subs: Number(row.subs) || 0,
  }));
  return { shifts: shiftSubs, day: dayTotal, week, month, people };
}
