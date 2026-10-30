import fs from 'fs';
import path from 'path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { FanslyLoad, FanslyMetrics } from './fansly-api';
import { shiftKey } from './payout-week.mjs';

const READ_CACHE = path.join(process.cwd(), 'data', 'supabase-read-cache.json');
const storedCache = new Map<string, { at: number; value: unknown }>();

function readFileCache() {
  try {
    return JSON.parse(fs.readFileSync(READ_CACHE, 'utf8')) as Record<string, { at: number; value: unknown }>;
  } catch {
    return {} as Record<string, { at: number; value: unknown }>;
  }
}

function remember<T>(key: string, value: T): T {
  const entry = { at: Date.now(), value };
  storedCache.set(key, entry);
  try {
    const all = readFileCache();
    all[key] = entry;
    fs.mkdirSync(path.dirname(READ_CACHE), { recursive: true });
    fs.writeFileSync(READ_CACHE, JSON.stringify(all));
  } catch {}
  return value;
}

function recall<T>(key: string): T | undefined {
  const saved = storedCache.get(key);
  if (saved && Date.now() - saved.at < 10 * 60 * 1000) return saved.value as T;
  const filed = readFileCache()[key];
  if (!filed || Date.now() - filed.at > 10 * 60 * 1000) return undefined;
  storedCache.set(key, filed);
  return filed.value as T;
}

class ClosedSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = ClosedSocket.CLOSED;
  constructor(public url: string) {}
  close() {}
  send() {}
  addEventListener() {}
  removeEventListener() {}
}

export function supabaseAdmin(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  const realtime = typeof WebSocket === 'undefined' ? { transport: ClosedSocket as unknown as typeof WebSocket } : {};
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, realtime });
}

type EarningRow = {
  username: string;
  name: string;
  day: string;
  net: number;
  gross: number;
  subs_net: number;
  tips_net: number;
  content_net: number;
  views: number;
  timeline_views: number;
  unique_viewers: number;
  watch_minutes: number;
  profile_visits: number;
  followers: number | null;
  subscribers: number | null;
};

function emptyMetrics(): FanslyMetrics {
  return { net: 0, gross: 0, subsNet: 0, tipsNet: 0, contentNet: 0, views: 0, timelineViews: 0, uniqueViewers: 0, watchMinutes: 0, profileVisits: 0, subscribers: null, followers: null, tags: [], topPosts: [], topPosts3: [] };
}

async function fetchAll<T>(key: string, build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[] | null> {
  const cached = recall<T[] | null>(key);
  if (cached !== undefined) return cached;
  const rows: T[] = [];
  const size = 10000;
  for (let from = 0; from < 20000; from += size) {
    const { data, error } = await build(from, from + size - 1);
    if (error || !data) return rows.length ? rows : null;
    rows.push(...data);
    if (data.length < size) break;
  }
  return remember(key, rows.length ? rows : null);
}

/** Saved Fansly numbers, or null when Supabase has no earnings yet. */
export async function loadStoredFansly(todayKey: string, windowStart: string, windowEnd: string): Promise<FanslyLoad | null> {
  const db = supabaseAdmin();
  if (!db) return null;
  const from = windowStart < shiftKey(todayKey, -89) ? windowStart : shiftKey(todayKey, -89);
  const data = await fetchAll<EarningRow>(`earnings:${from}:${todayKey}`, (start, end) => db.from('earnings').select('username,name,day,net,gross,subs_net,tips_net,content_net,views,timeline_views,unique_viewers,watch_minutes,profile_visits,followers,subscribers').gte('day', from).lte('day', todayKey).range(start, end));
  if (!data?.length) return null;
  const rows = data;
  const metrics = new Map<string, FanslyMetrics>();
  const days = new Map<string, Map<string, number>>();
  const accounts = new Map<string, { id: string; username: string; name: string; avatar: string }>();
  for (const row of rows) {
    const key = row.username.toLowerCase();
    if (!accounts.has(key)) accounts.set(key, { id: key, username: row.username, name: row.name || row.username, avatar: '' });
    const byDay = days.get(key) || new Map<string, number>();
    byDay.set(row.day, Number(row.net) || 0);
    days.set(key, byDay);
    const mine = metrics.get(key) || emptyMetrics();
    if (row.day >= windowStart && row.day <= windowEnd) {
      mine.net += Number(row.net) || 0;
      mine.gross += Number(row.gross) || 0;
      mine.subsNet += Number(row.subs_net) || 0;
      mine.tipsNet += Number(row.tips_net) || 0;
      mine.contentNet += Number(row.content_net) || 0;
      mine.views += Number(row.views) || 0;
      mine.timelineViews += Number(row.timeline_views) || 0;
      mine.uniqueViewers += Number(row.unique_viewers) || 0;
      mine.watchMinutes += Number(row.watch_minutes) || 0;
      mine.profileVisits += Number(row.profile_visits) || 0;
    }
    if (row.followers != null) mine.followers = Number(row.followers);
    if (row.subscribers != null) mine.subscribers = Number(row.subscribers);
    metrics.set(key, mine);
  }
  const { data: posts } = await db.from('fyp_posts').select('fansly_username,creator,views,media_likes,post_likes,post_id').not('views', 'is', null).order('views', { ascending: false }).limit(40);
  const top = (Array.isArray(posts) ? posts : []).map((post) => ({
    username: String(post.fansly_username || ''),
    name: String(post.creator || post.fansly_username || ''),
    views: Number(post.views) || 0,
    likes: Number(post.media_likes ?? post.post_likes) || 0,
    mediaOfferId: String(post.post_id || ''),
  })).filter((post) => post.likes >= 10).slice(0, 20);
  for (const post of top) {
    const mine = metrics.get(post.username.toLowerCase());
    if (!mine) continue;
    mine.topPosts.push({ views: post.views, likes: post.likes, mediaOfferId: '' });
    mine.topPosts3.push({ views: post.views, likes: post.likes, mediaOfferId: '' });
  }
  return {
    accounts: [...accounts.values()],
    metrics,
    days,
    dayMoney: new Map(),
    viewDays: new Map(),
    error: '',
  };
}

export type StoredPost = {
  id: string;
  username: string;
  name: string;
  posted_at: string | null;
  day: string | null;
  status: string;
  caption: string;
  notes: string;
  poster: string;
  method: string;
  post_type: string;
  url: string;
  autonumber: string;
  views: number | null;
  likes: number | null;
};

export async function loadStoredPosts(start: string, end: string): Promise<StoredPost[] | null> {
  const db = supabaseAdmin();
  if (!db) return null;
  return fetchAll<StoredPost>(`posts:${start}:${end}`, (from, to) => db.from('posts').select('id,username,name,posted_at,day,status,caption,notes,poster,method,post_type,url,autonumber,views,likes').gte('day', start).lte('day', end).range(from, to));
}

export type PostMetric = {
  id: string;
  username: string;
  name: string;
  day: string | null;
  airtable_id: string | null;
  views: number | null;
  preview_views: number | null;
  likes: number | null;
  interaction_time: number | null;
  preview_interaction_time: number | null;
  ai_note: string;
};

export type FypPostRecord = {
  post_id: string;
  airtable_id: string | null;
  fansly_username: string;
  creator: string;
  posted_at: string | null;
  url: string;
  views: number | null;
  media_likes: number | null;
  post_likes: number | null;
  engagement: number | null;
};

export async function loadFypPosts(start: string, end: string): Promise<FypPostRecord[] | null> {
  const db = supabaseAdmin();
  if (!db) return null;
  const from = new Date(`${start}T00:00:00+08:00`).toISOString();
  const to = new Date(`${end}T23:59:59.999+08:00`).toISOString();
  return fetchAll<FypPostRecord>(`fyp-posts:${start}:${end}`, (offset, limit) => db.from('fyp_posts').select('post_id,airtable_id,fansly_username,creator,posted_at,url,views,media_likes,post_likes,engagement').gte('posted_at', from).lte('posted_at', to).range(offset, limit));
}

export async function loadPostMetrics(start: string, end: string): Promise<PostMetric[] | null> {
  const db = supabaseAdmin();
  if (!db) return null;
  return fetchAll<PostMetric>(`metrics:${start}:${end}`, (from, to) => db.from('post_metrics').select('id,username,name,day,airtable_id,views,preview_views,likes,interaction_time,preview_interaction_time,ai_note').gte('day', start).lte('day', end).range(from, to));
}

export async function loadStoredErrors(): Promise<{ at: string; level: 'error' | 'warn'; account: string; message: string }[] | null> {
  const db = supabaseAdmin();
  if (!db) return null;
  const { data, error } = await db.from('errors').select('at,level,account,message').order('at', { ascending: false }).limit(40);
  if (error || !Array.isArray(data) || !data.length) return null;
  return data.map((row) => ({
    at: String(row.at || ''),
    level: row.level === 'warn' ? 'warn' as const : 'error' as const,
    account: String(row.account || ''),
    message: String(row.message || ''),
  }));
}
