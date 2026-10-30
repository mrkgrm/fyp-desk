import fs from 'fs';
import path from 'path';
import { fromManila, manilaKey, shiftKey } from './payout-week.mjs';

const PH_DAY_CACHE = path.join(process.cwd(), 'data', 'ph-day-net.json');

const BASE = 'https://app.onlyfansapi.com';

export type FanslyMetrics = {
  net: number;
  gross: number;
  subsNet: number;
  tipsNet: number;
  contentNet: number;
  views: number;
  timelineViews: number;
  uniqueViewers: number;
  watchMinutes: number;
  profileVisits: number;
  subscribers: number | null;
  followers: number | null;
  tags: { tag: string; views: number }[];
  topPosts: { views: number; likes: number; mediaOfferId: string }[];
  topPosts3: { views: number; likes: number; mediaOfferId: string }[];
};

export type FanslyAccount = {
  id: string;
  username: string;
  name: string;
  avatar: string;
};

function httpUrl(value: unknown) {
  return typeof value === 'string' && value.startsWith('http') ? value : '';
}

function avatarUrl(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return httpUrl(value);
  if (typeof value !== 'object') return '';
  const record = value as { locations?: { location?: string }[]; variants?: { locations?: { location?: string }[] }[] };
  const fromList = (list?: { location?: string }[]) => (list || []).map((item) => httpUrl(item?.location)).find(Boolean) || '';
  return fromList(record.locations) || fromList(record.variants?.[0]?.locations);
}

export type DayMoney = { gross: number; subsNet: number; tipsNet: number; contentNet: number };
export type DayViews = { views: number; timelineViews: number; uniqueViewers: number; watchMinutes: number; profileVisits: number };

export type FanslyLoad = {
  accounts: FanslyAccount[];
  metrics: Map<string, FanslyMetrics>;
  days: Map<string, Map<string, number>>;
  dayMoney: Map<string, Map<string, DayMoney>>;
  viewDays: Map<string, Map<string, DayViews>>;
  error: string;
};

type Snapshot = { at: number; key: string } & FanslyLoad;

let snapshot: Snapshot | null = null;

function token() {
  return process.env.ONLYFANS_API_KEY || '';
}

async function api(path: string) {
  const key = token();
  if (!key) throw new Error('ONLYFANS_API_KEY is not set');
  const response = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Fansly API ${response.status}`);
  return response.json();
}

function dollars(units: unknown) {
  const n = Number(units);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 1000;
}

function isoBound(key: string, end: boolean) {
  const [year, month, day] = key.split('-').map(Number);
  const instant = end ? fromManila(year, month, day, 23, 59, 59, 999) : fromManila(year, month, day, 0, 0, 0, 0);
  return instant.toISOString();
}

function eachDay(start: string, end: string) {
  const days: string[] = [];
  let cursor = start;
  while (cursor <= end && days.length < 80) {
    days.push(cursor);
    cursor = shiftKey(cursor, 1);
  }
  return days;
}

function readPhDays() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PH_DAY_CACHE, 'utf8')) as Record<string, Record<string, number>>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {} as Record<string, Record<string, number>>;
  }
}

function writePhDays(cache: Record<string, Record<string, number>>) {
  try {
    fs.mkdirSync(path.dirname(PH_DAY_CACHE), { recursive: true });
    fs.writeFileSync(PH_DAY_CACHE, JSON.stringify(cache));
  } catch {
    // Vercel cannot write this cache. The read still works.
  }
}

function readTopPosts(insights: { data?: { dataset?: { topFypMediaOffers?: { mediaOfferId?: string; views?: number }[] }; aggregationData?: { accountMedia?: { id?: string; mediaId?: string; likeCount?: number }[]; creatorMediaOfferLocations?: { mediaOfferId?: string; mediaId?: string }[] } } } | null) {
  const likes = new Map<string, number>();
  for (const media of insights?.data?.aggregationData?.accountMedia || []) {
    const likesOnPost = Number(media.likeCount) || 0;
    if (media.mediaId) likes.set(String(media.mediaId), likesOnPost);
    if (media.id) likes.set(String(media.id), likesOnPost);
  }
  const offerMedia = new Map<string, string>();
  for (const loc of insights?.data?.aggregationData?.creatorMediaOfferLocations || []) {
    if (loc?.mediaOfferId && loc?.mediaId) offerMedia.set(String(loc.mediaOfferId), String(loc.mediaId));
  }
  return (insights?.data?.dataset?.topFypMediaOffers || [])
    .map((offer) => {
      const mediaOfferId = String(offer.mediaOfferId || '');
      const mediaId = offerMedia.get(mediaOfferId) || '';
      return {
        mediaOfferId,
        views: Number(offer.views) || 0,
        likes: likes.get(mediaId) || likes.get(mediaOfferId) || 0,
      };
    })
    .filter((post) => post.views > 0 || post.likes > 0)
    .sort((a, b) => b.views - a.views)
    .slice(0, 10);
}

async function philippineDayNet(accountId: string, day: string) {
  const stats = await api(`/api/fansly/${accountId}/earnings/stats?after=${encodeURIComponent(isoBound(day, false))}&before=${encodeURIComponent(isoBound(day, true))}`).catch(() => null);
  if (!stats || !Array.isArray(stats.data)) return null;
  return stats.data.reduce((sum: number, row: { totalNet?: unknown }) => sum + dollars(row.totalNet), 0);
}

async function fillPhilippineDays(accounts: FanslyAccount[], days: Map<string, Map<string, number>>, metrics: Map<string, FanslyMetrics>, start: string, end: string, windowStart: string) {
  const today = manilaKey(new Date());
  const cache = readPhDays();
  const jobs: { account: FanslyAccount; day: string }[] = [];
  for (const account of accounts) {
    const saved = cache[account.username.toLowerCase()] || {};
    for (const day of eachDay(start, end)) {
      if (day < today && Number.isFinite(saved[day])) continue;
      jobs.push({ account, day });
    }
  }
  await pool(jobs, 6, async (job) => {
    const loaded = await philippineDayNet(job.account.id, job.day);
    if (loaded == null) return;
    const net = Math.round(loaded * 100) / 100;
    const key = job.account.username.toLowerCase();
    if (job.day < today) {
      cache[key] = cache[key] || {};
      cache[key][job.day] = net;
    }
    const byDay = days.get(key);
    if (byDay) byDay.set(job.day, (byDay.get(job.day) || 0) + net);
    if (job.day >= windowStart && job.day <= end) {
      const mine = metrics.get(key);
      if (mine) mine.net += net;
    }
  });
  for (const account of accounts) {
    const key = account.username.toLowerCase();
    const saved = cache[key] || {};
    const byDay = days.get(key);
    const mine = metrics.get(key);
    if (!byDay) continue;
    for (const day of eachDay(start, end)) {
      if (byDay.has(day) || !Number.isFinite(saved[day])) continue;
      byDay.set(day, saved[day]);
      if (mine && day >= windowStart && day <= end) mine.net += saved[day];
    }
  }
  writePhDays(cache);
}

function bucket(type: number) {
  if (type === 15001) return 'subs' as const;
  if (type === 7101) return 'tips' as const;
  return 'content' as const;
}

async function pool<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await run(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

function emptyMetrics(): FanslyMetrics {
  return { net: 0, gross: 0, subsNet: 0, tipsNet: 0, contentNet: 0, views: 0, timelineViews: 0, uniqueViewers: 0, watchMinutes: 0, profileVisits: 0, subscribers: null, followers: null, tags: [], topPosts: [], topPosts3: [] };
}

export type RankedFanslyPost = {
  username: string;
  name: string;
  mediaOfferId: string;
  postId: string;
  views: number;
  likes: number;
  postedAt: string | null;
};

const rankedCache = new Map<string, { at: number; matched: number; names: string[]; posts: RankedFanslyPost[] }>();

function insightPosts(insights: { data?: { dataset?: { topFypMediaOffers?: { mediaOfferId?: string; views?: number }[] }; aggregationData?: { accountMedia?: { id?: string; mediaId?: string; likeCount?: number }[]; creatorMediaOfferLocations?: { mediaOfferId?: string; correlationId?: string; mediaId?: string; createdAt?: number }[] } } } | null): RankedFanslyPost[] {
  const likes = new Map<string, number>();
  for (const media of insights?.data?.aggregationData?.accountMedia || []) {
    const likesOnPost = Number(media.likeCount) || 0;
    if (media.mediaId) likes.set(String(media.mediaId), likesOnPost);
    if (media.id) likes.set(String(media.id), likesOnPost);
  }
  const places = new Map<string, { postId: string; mediaId: string; postedAt: string | null }>();
  for (const loc of insights?.data?.aggregationData?.creatorMediaOfferLocations || []) {
    if (!loc?.mediaOfferId) continue;
    const created = Number(loc.createdAt);
    places.set(String(loc.mediaOfferId), {
      postId: String(loc.correlationId || ''),
      mediaId: String(loc.mediaId || ''),
      postedAt: Number.isFinite(created) && created > 0 ? new Date(created > 1e12 ? created : created * 1000).toISOString() : null,
    });
  }
  return (insights?.data?.dataset?.topFypMediaOffers || [])
    .map((offer) => {
      const mediaOfferId = String(offer.mediaOfferId || '');
      const place = places.get(mediaOfferId);
      return {
        username: '',
        name: '',
        mediaOfferId,
        postId: place?.postId || '',
        views: Number(offer.views) || 0,
        likes: likes.get(place?.mediaId || '') || likes.get(mediaOfferId) || 0,
        postedAt: place?.postedAt || null,
      };
    })
    .filter((post) => post.mediaOfferId && (post.views > 0 || post.likes > 0))
    .sort((a, b) => b.views - a.views || b.likes - a.likes);
}

function editDistance(left: string, right: string) {
  const rows = Array.from({ length: left.length + 1 }, (_, index) => [index]);
  for (let column = 1; column <= right.length; column += 1) rows[0][column] = column;
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      rows[row][column] = Math.min(rows[row - 1][column] + 1, rows[row][column - 1] + 1, rows[row - 1][column - 1] + cost);
    }
  }
  return rows[left.length][right.length];
}

function accountMatches(query: string, name: string, username: string) {
  const needle = query.toLowerCase().trim();
  if (!needle) return true;
  const blob = `${name} ${username}`.toLowerCase();
  if (blob.includes(needle)) return true;
  const compact = needle.replace(/[^a-z0-9]+/g, '');
  if (compact.length < 3) return false;
  return blob.split(/[^a-z0-9]+/).filter((part) => part.length >= 3).some((part) => {
    const gap = Math.abs(part.length - compact.length);
    if (gap > 1) return false;
    if (part.startsWith(compact) || compact.startsWith(part)) return true;
    return editDistance(part, compact) <= 1;
  });
}

export async function rankedFanslyPosts(range: string, query = '') {
  const key = `${range}|${query.toLowerCase().trim()}`;
  const saved = rankedCache.get(key);
  if (saved && Date.now() - saved.at < 3 * 60 * 1000) return { matched: saved.matched, names: saved.names, posts: saved.posts, error: '' };
  if (!token()) return { matched: 0, names: [] as string[], posts: [] as RankedFanslyPost[], error: 'ONLYFANS_API_KEY is not set' };
  try {
    const listed = await api('/api/fansly/accounts');
    const accounts: FanslyAccount[] = (Array.isArray(listed) ? listed : [])
      .filter((row: { is_authenticated?: boolean; fansly_username?: string }) => row?.is_authenticated && row.fansly_username)
      .map((row: { id: string; fansly_username: string; display_name?: string; fansly_user_data?: { display_name?: string } }) => ({
        id: String(row.id),
        username: String(row.fansly_username),
        name: String(row.display_name || row.fansly_user_data?.display_name || row.fansly_username),
        avatar: '',
      }))
      .filter((account) => accountMatches(query, account.name, account.username));
    const groups = await pool(accounts, 6, async (account) => {
      const insights = await api(`/api/fansly/${account.id}/insights?range=${encodeURIComponent(range)}`).catch(() => null);
      return insightPosts(insights).map((post) => ({ ...post, username: account.username, name: account.name }));
    });
    const posts = groups.flat().sort((a, b) => b.views - a.views || b.likes - a.likes);
    const names = accounts.map((account) => account.name);
    if (accounts.length) rankedCache.set(key, { at: Date.now(), matched: accounts.length, names, posts });
    return { matched: accounts.length, names, posts, error: '' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Fansly API failed';
    return { matched: 0, names: [] as string[], posts: [] as RankedFanslyPost[], error: message };
  }
}

export async function loadFanslyMetrics(options: { start: string; end: string; insight: string }) {
  const cacheKey = `${options.start}|${options.end}|${options.insight}`;
  if (snapshot && snapshot.key === cacheKey && Date.now() - snapshot.at < 90_000) {
    return snapshot;
  }
  if (!token()) {
    return { accounts: [] as FanslyAccount[], metrics: new Map<string, FanslyMetrics>(), days: new Map<string, Map<string, number>>(), dayMoney: new Map(), viewDays: new Map(), error: 'ONLYFANS_API_KEY is not set' };
  }
  try {
    const listed = await api('/api/fansly/accounts');
    const accounts: FanslyAccount[] = (Array.isArray(listed) ? listed : [])
      .filter((row: { is_authenticated?: boolean; fansly_username?: string }) => row?.is_authenticated && row.fansly_username)
      .map((row: { id: string; fansly_username: string; display_name?: string; fansly_user_data?: { display_name?: string; avatar?: unknown } }) => ({
        id: String(row.id),
        username: String(row.fansly_username),
        name: String(row.display_name || row.fansly_user_data?.display_name || row.fansly_username),
        avatar: avatarUrl(row.fansly_user_data?.avatar),
      }));
    const metrics = new Map<string, FanslyMetrics>();
    const days = new Map<string, Map<string, number>>();
    const dayMoney = new Map<string, Map<string, DayMoney>>();
    const viewDays = new Map<string, Map<string, DayViews>>();
    const historyStart = shiftKey(options.end, -55);
    const statsStart = historyStart < options.start ? historyStart : options.start;
    for (const account of accounts) {
      const key = account.username.toLowerCase();
      metrics.set(key, emptyMetrics());
      days.set(key, new Map());
      dayMoney.set(key, new Map());
      viewDays.set(key, new Map());
    }
    const profiles = accounts[0]
      ? await api(`/api/fansly/${accounts[0].id}/users/${accounts.map((account) => encodeURIComponent(account.username)).join(',')}`).catch(() => null)
      : null;
    const profileRows = Array.isArray(profiles?.data) ? profiles.data : [];
    for (const row of profileRows) {
      const found = metrics.get(String(row.username || '').toLowerCase());
      if (!found) continue;
      const subscribers = Number(row.subscriberCount);
      const followers = Number(row.followCount);
      found.subscribers = Number.isFinite(subscribers) ? subscribers : null;
      found.followers = Number.isFinite(followers) ? followers : null;
      const photo = avatarUrl(row.avatar);
      const account = accounts.find((item) => item.username.toLowerCase() === String(row.username || '').toLowerCase());
      if (account && photo) account.avatar = photo;
    }
    await pool(accounts, 6, async (account) => {
      const mine = metrics.get(account.username.toLowerCase());
      if (!mine) return;
      const [stats, insights] = await Promise.all([
        api(`/api/fansly/${account.id}/earnings/stats?after=${encodeURIComponent(isoBound(statsStart, false))}&before=${encodeURIComponent(isoBound(options.end, true))}`).catch(() => null),
        api(`/api/fansly/${account.id}/insights?range=${encodeURIComponent(options.insight)}`).catch(() => null),
      ]);
      for (const row of Array.isArray(stats?.data) ? stats.data : []) {
        const day = manilaKey(new Date(Number(row.timestamp)));
        if (!day || day < statsStart || day > options.end) continue;
        const net = dollars(row.totalNet);
        const gross = dollars(row.totalGross);
        const key = account.username.toLowerCase();
        const part = dayMoney.get(key)?.get(day) || { gross: 0, subsNet: 0, tipsNet: 0, contentNet: 0 };
        part.gross += gross;
        const split = bucket(Number(row.type));
        if (split === 'subs') part.subsNet += net;
        else if (split === 'tips') part.tipsNet += net;
        else part.contentNet += net;
        dayMoney.get(key)?.set(day, part);
        if (day < options.start || day > options.end) continue;
        mine.gross += gross;
        const kind = bucket(Number(row.type));
        if (kind === 'subs') mine.subsNet += net;
        else if (kind === 'tips') mine.tipsNet += net;
        else mine.contentNet += net;
      }
      const dataset = insights?.data?.dataset || {};
      const points = dataset.datapoints || [];
      for (const point of points) {
        const day = manilaKey(new Date(Number(point.timestamp)));
        if (!day || day < options.start || day > options.end) continue;
        for (const stat of point.stats || []) {
          const views = Number(stat.views) || 0;
          const viewRow = viewDays.get(account.username.toLowerCase())?.get(day) || { views: 0, timelineViews: 0, uniqueViewers: 0, watchMinutes: 0, profileVisits: 0 };
          if (Number(stat.type) === 1) {
            mine.timelineViews += views;
            viewRow.timelineViews += views;
          } else {
            mine.views += views;
            mine.uniqueViewers += Number(stat.uniqueViewers) || 0;
            mine.watchMinutes += (Number(stat.interactionTime) || 0) / 60000;
            viewRow.views += views;
            viewRow.uniqueViewers += Number(stat.uniqueViewers) || 0;
            viewRow.watchMinutes += (Number(stat.interactionTime) || 0) / 60000;
          }
          viewDays.get(account.username.toLowerCase())?.set(day, viewRow);
        }
      }
      for (const point of dataset.profileDatapoints || []) {
        const day = manilaKey(new Date(Number(point.timestamp)));
        if (!day || day < options.start || day > options.end) continue;
        for (const stat of point.stats || []) {
          const kind = Number(stat.type);
          if (kind === 44000 || kind === 10000) {
            const visits = Number(stat.views) || 0;
            mine.profileVisits += visits;
            const viewRow = viewDays.get(account.username.toLowerCase())?.get(day) || { views: 0, timelineViews: 0, uniqueViewers: 0, watchMinutes: 0, profileVisits: 0 };
            viewRow.profileVisits += visits;
            viewDays.get(account.username.toLowerCase())?.set(day, viewRow);
          }
        }
      }
      const names = new Map<string, string>();
      for (const tag of insights?.data?.aggregationData?.tags || []) {
        if (tag?.id && tag?.tag) names.set(String(tag.id), String(tag.tag));
      }
      mine.tags = (dataset.topFypTags || [])
        .map((tag: { tagId?: string; views?: number }) => ({ tag: names.get(String(tag.tagId)) || '', views: Number(tag.views) || 0 }))
        .filter((tag: { tag: string; views: number }) => tag.tag && tag.views > 0)
        .sort((a: { views: number }, b: { views: number }) => b.views - a.views)
        .slice(0, 8);
      mine.topPosts = readTopPosts(insights);
      mine.topPosts3 = options.insight === 'last_3_days'
        ? mine.topPosts
        : readTopPosts(await api(`/api/fansly/${account.id}/insights?range=last_3_days`).catch(() => null));
    });
    await fillPhilippineDays(accounts, days, metrics, statsStart, options.end, options.start);
    snapshot = { at: Date.now(), key: cacheKey, accounts, metrics, days, dayMoney, viewDays, error: '' };
    return snapshot;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Fansly API failed';
    return { accounts: [] as FanslyAccount[], metrics: new Map<string, FanslyMetrics>(), days: new Map<string, Map<string, number>>(), dayMoney: new Map(), viewDays: new Map(), error: message };
  }
}
