import fs from 'fs';
import path from 'path';
import { rankedFanslyPosts, type RankedFanslyPost } from './fansly-api';
import { manilaKey, shiftKey } from './payout-week.mjs';
import { modelShiftEarnings, ownerFigures, type ModelShiftMoney } from './shift-earnings';
import { subsFigures } from './shift-subs';
import { supabaseAdmin } from './supabase';

const CHATS = path.join(process.cwd(), 'data', 'telegram-chats.json');
const POSTERS = ['Arthur', 'Julian', 'Jade', 'Catherine'];

function token() {
  return process.env.TELEGRAM_BOT_TOKEN || '';
}

function readChats() {
  const fromEnv = String(process.env.TELEGRAM_CHAT_IDS || '').trim();
  if (fromEnv) return fromEnv.split(/[,\s]+/).map(Number).filter((id) => Number.isFinite(id));
  try {
    const parsed = JSON.parse(fs.readFileSync(CHATS, 'utf8'));
    return Array.isArray(parsed.chats) ? parsed.chats.map(Number).filter((id: number) => Number.isFinite(id)) : [];
  } catch {
    return [];
  }
}

function rememberChat(id: number) {
  const chats = new Set(readChats());
  chats.add(id);
  fs.mkdirSync(path.dirname(CHATS), { recursive: true });
  fs.writeFileSync(CHATS, JSON.stringify({ chats: [...chats] }));
}

export async function telegramSend(chatId: number, text: string) {
  const key = token();
  if (!key) return;
  const chunks = text.length <= 3900 ? [text] : text.match(/[\s\S]{1,3900}/g) || [text];
  for (const chunk of chunks) {
    const response = await fetch(`https://api.telegram.org/bot${key}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
    if (!response.ok) throw new Error(`Telegram ${response.status}`);
  }
}

function money(amount: number) {
  const sign = amount < 0 ? '-' : '';
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

function posterName(notes: string, poster: string) {
  const blob = `${notes} ${poster}`.trim();
  if (/timeline/i.test(blob)) return 'Timeline';
  if (/\barthur\b|^bot$/i.test(blob)) return 'Arthur';
  if (/julian/i.test(blob)) return 'Julian';
  if (/jade/i.test(blob)) return 'Jade';
  if (/catherine|katherine/i.test(blob)) return 'Catherine';
  return poster.trim() || notes.trim() || 'Unassigned';
}

function slotLabel(slot: number) {
  if (slot === 8) return '8:00 AM';
  if (slot === 16) return '4:00 PM';
  return '11:59 PM';
}

export async function buildDeskMessage(slot: number) {
  const db = supabaseAdmin();
  if (!db) return 'Supabase is not connected.';
  const today = manilaKey(new Date());
  const yesterday = shiftKey(today,  -1);
  const threeAgo = shiftKey(today, -2);
  const { data: earnings } = await db.from('earnings').select('net').eq('day', today);
  const net = (earnings || []).reduce((sum, row) => sum + (Number(row.net) || 0), 0);
  const { data: audience } = await db.from('audience').select('name,username,subscribers,followers,new_subscribers,new_followers').eq('day', today).eq('slot', slot);
  const lines = [`${slotLabel(slot)}, Philippine time`, '', `Today so far: ${money(net)} net`];
  const people = audience || [];
  const newSubs = people.reduce((sum, row) => sum + (Number(row.new_subscribers) || 0), 0);
  const newFollowers = people.reduce((sum, row) => sum + (Number(row.new_followers) || 0), 0);
  lines.push(`New subscribers: ${newSubs}`, `New followers: ${newFollowers}`);
  const changed = people.filter((row) => (Number(row.new_subscribers) || 0) !== 0 || (Number(row.new_followers) || 0) !== 0);
  if (changed.length) {
    lines.push('');
    for (const row of changed) {
      const bits = [];
      if ((Number(row.subscribers) || 0) > 0 || (Number(row.new_subscribers) || 0) !== 0) bits.push(`${Number(row.new_subscribers) || 0} subs`);
      if ((Number(row.followers) || 0) > 0 || (Number(row.new_followers) || 0) !== 0) bits.push(`${Number(row.new_followers) || 0} followers`);
      lines.push(`${row.name || row.username}: ${bits.join(', ')}`);
    }
  }
  if (slot === 8) {
    const { data: posts } = await db.from('posts').select('username,name,notes,poster,source').eq('day', yesterday).eq('source', 'airtable');
    const groups = new Map<string, Map<string, number>>();
    for (const post of posts || []) {
      const who = posterName(String(post.notes || ''), String(post.poster || ''));
      const models = groups.get(who) || new Map<string, number>();
      const label = String(post.name || post.username || 'Model');
      models.set(label, (models.get(label) || 0) + 1);
      groups.set(who, models);
    }
    lines.push('', `Yesterday's posts, ${yesterday}`);
    const names = [...new Set([...POSTERS, ...groups.keys()])];
    for (const name of names) {
      const models = groups.get(name);
      const total = models ? [...models.values()].reduce((sum, count) => sum + count, 0) : 0;
      lines.push(`${name}: ${total}`);
      if (!models) continue;
      for (const [model, count] of [...models.entries()].sort((a, b) => b[1] - a[1])) lines.push(`  ${model} ${count}`);
    }
  }
  const since = new Date(`${threeAgo}T00:00:00+08:00`).toISOString();
  const { data: ranked } = await db.from('fyp_posts').select('creator,fansly_username,notes,poster,views,media_likes,post_likes,posted_at').gte('posted_at', since).not('views', 'is', null).order('views', { ascending: false }).limit(200);
  const tops = new Map<string, { name: string; views: number; likes: number }[]>();
  for (const post of ranked || []) {
    const likes = Number(post.media_likes ?? post.post_likes) || 0;
    if (likes < 10) continue;
    const who = posterName(String(post.notes || ''), String(post.poster || ''));
    if (who === 'Unassigned') continue;
    const list = tops.get(who) || [];
    if (list.length >= 3) continue;
    list.push({ name: String(post.creator || post.fansly_username), views: Number(post.views) || 0, likes });
    tops.set(who, list);
  }
  lines.push('', 'Top posts, last 3 days');
  for (const name of [...new Set([...POSTERS, ...tops.keys()])]) {
    const list = tops.get(name) || [];
    lines.push(list.length ? `${name}: ${list.map((post, index) => `${index + 1}. ${post.name} ${post.views} views, ${post.likes} likes`).join(' · ')}` : `${name}: no post with 10 likes`);
  }
  return lines.join('\n');
}

export async function sendDeskUpdate(slot: number) {
  const text = await buildDeskMessage(slot);
  const chats = readChats();
  for (const chatId of chats) await telegramSend(chatId, text);
  return chats.length;
}

function ownerMoney(amount: number) {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function modelRecap(models: ModelShiftMoney[], throughShift: 1 | 2 | 3) {
  const lines = ['Models'];
  for (const model of models) {
    const total = Math.round(model.shifts.slice(0, throughShift).reduce((sum, amount) => sum + amount, 0) * 100) / 100;
    if (total <= 0) continue;
    lines.push(`${model.name}: ${ownerMoney(total)}`);
  }
  return lines.length > 1 ? lines : [];
}

export function formatOwnerMessage(figures: Awaited<ReturnType<typeof ownerFigures>>, models: ModelShiftMoney[] = [], throughShift: 1 | 2 | 3 = 3) {
  return [
    `Shift 1: ${ownerMoney(figures.shifts[0])}`,
    `Shift 2: ${ownerMoney(figures.shifts[1])}`,
    `Shift 3: ${ownerMoney(figures.shifts[2])}`,
    '',
    'Total day:',
    ownerMoney(figures.day),
    '',
    'Total week:',
    ownerMoney(figures.week),
    '',
    'total me week:',
    ownerMoney(figures.meWeek),
    '',
    'Avg week:',
    ownerMoney(figures.avgWeek),
    '',
    'Total Month:',
    ownerMoney(figures.month),
    '',
    'Monthly for me:',
    ownerMoney(figures.meMonth),
    '',
    'Avg daily for me:',
    ownerMoney(figures.avgDaily),
    '',
    'Goal left:',
    ownerMoney(figures.goalLeft),
    '',
    'Need:',
    ownerMoney(figures.need),
    '',
    'Goal',
    '100 — 3k',
    '166 — 5k',
    '333 — 10k',
    '',
    ...modelRecap(models, throughShift),
  ].join('\n');
}

/** 08:00 and 16:00 report today, still open. 00:00 reports the day that just ended. */
export async function sendOwnerUpdate(slot: number) {
  const today = manilaKey(new Date());
  const midnight = slot === 0;
  const reportDay = midnight ? shiftKey(today, -1) : today;
  const through = slot === 8 ? 1 : slot === 16 ? 2 : 3;
  const text = formatOwnerMessage(await ownerFigures(reportDay, through), await modelShiftEarnings(reportDay, through), through);
  const chats = readChats();
  for (const chatId of chats) await telegramSend(chatId, text);
  return text;
}

export function formatSubsMessage(figures: Awaited<ReturnType<typeof subsFigures>>) {
  const lines = [
    `Shift 1: ${figures.shifts[0]}`,
    `Shift 2: ${figures.shifts[1]}`,
    `Shift 3: ${figures.shifts[2]}`,
  ];
  const people = figures.people
    .map((person) => ({ name: person.name.split('/')[0].trim() || person.name.trim(), subs: person.subs }))
    .filter((person) => person.name && person.subs > 0)
    .sort((a, b) => b.subs - a.subs || a.name.localeCompare(b.name));
  for (const person of people) lines.push(`${person.name}: ${person.subs}`);
  lines.push(
    'Total day:',
    String(figures.day),
    'Total week:',
    String(figures.week),
    'Total Month:',
    String(figures.month),
  );
  return lines.join('\n');
}

/** Midnight only. Reports the day that just ended. */
export async function sendSubsUpdate() {
  const reportDay = shiftKey(manilaKey(new Date()), -1);
  const text = formatSubsMessage(await subsFigures(reportDay));
  const chats = readChats();
  for (const chatId of chats) await telegramSend(chatId, text);
  return text;
}

const COUNT_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const DAY_WORDS: Record<string, number> = {
  ...COUNT_WORDS,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, sixty: 60, ninety: 90,
};
const ASK_STOP = new Set([
  'what', 'whats', 'was', 'were', 'is', 'the', 'best', 'top', 'first', 'post', 'posts', 'for', 'on', 'in', 'of', 'a', 'an',
  'last', 'past', 'previous', 'days', 'day', 'to', 'me', 'my', 'please', 'show', 'give', 'how', 'many', 'views', 'likes',
  'with', 'and', 'from', 'during', 'over', 'this', 'that', 'which', 'who', 'posted', 'by', 'week', 'month', 'yesterday',
  ...Object.keys(DAY_WORDS),
]);

function spoken(table: Record<string, number>, token: string) {
  if (/^\d+$/.test(token)) return Number(token);
  return table[token] ?? null;
}

function plainQuestion(question: string) {
  return question.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function postAsk(question: string) {
  const q = plainQuestion(question);
  const countMatch = q.match(/\b(?:top|best|first)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  const count = Math.min(10, Math.max(1, countMatch ? spoken(COUNT_WORDS, countMatch[1]) || 1 : 1));
  let days: number | null = null;
  const dayMatch = q.match(/\b(?:last|past|previous)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|sixty|ninety)\s+days?\b/);
  if (dayMatch) days = spoken(DAY_WORDS, dayMatch[1]);
  else if (/\byesterday\b/.test(q)) days = 1;
  else if (/\b(?:last|this)\s+week\b/.test(q)) days = 7;
  else if (/\b(?:last|this)\s+month\b/.test(q)) days = 30;
  const range = days == null ? 'last_7_days' : days <= 3 ? 'last_3_days' : days <= 7 ? 'last_7_days' : 'last_30_days';
  const model = q
    .replace(/\b(?:top|best|first)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/g, ' ')
    .replace(/\b(?:last|past|previous)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|sixty|ninety)\s+days?\b/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !ASK_STOP.has(word) && !/^\d+$/.test(word))
    .join(' ')
    .trim();
  const window = range === 'last_3_days' ? 'last 3 days' : range === 'last_7_days' ? 'last 7 days' : 'last 30 days';
  return { count, range, model, window };
}

function countLabel(value: number) {
  return Math.round(value).toLocaleString('en-US');
}

function formatRankedPost(post: RankedFanslyPost, detail: { caption?: string; day?: string; notes?: string; poster?: string } | undefined, index: number, total: number) {
  const caption = String(detail?.caption || '').replace(/\s+\n/g, '\n').trim().slice(0, 500);
  const lines = [`${total > 1 ? `${index + 1}. ` : ''}${caption || post.name || post.username}`];
  const when = detail?.day || (post.postedAt ? manilaKey(new Date(post.postedAt)) : '');
  lines.push(`${when ? `${when} · ` : ''}${countLabel(post.views)} views, ${countLabel(post.likes)} likes`);
  if (post.postId) lines.push(`https://fansly.com/post/${post.postId}`);
  const who = posterName(String(detail?.notes || ''), String(detail?.poster || ''));
  if (who === 'Arthur' || who === 'Julian' || who === 'Jade' || who === 'Catherine' || who === 'Timeline') lines.push(`Posted by ${who}`);
  return lines.join('\n');
}

function wantsArthurPosts(question: string) {
  const q = plainQuestion(question);
  return /\b(arthur|bot)\b/.test(q) && /\b(post|note)/.test(q);
}

async function answerArthurPosts(question: string) {
  const ask = postAsk(question);
  const db = supabaseAdmin();
  if (!db) return 'Supabase is not connected.';
  const ranked = await rankedFanslyPosts('last_30_days');
  if (ranked.error && !ranked.posts.length) return 'I could not reach Fansly for the Arthur and BOT posts.';
  const { data, error } = await db.from('posts').select('url,username,day,caption,notes').in('notes', ['Arthur', 'BOT']).like('url', 'https://fansly.com/post/%').limit(1000);
  if (error) return 'I could not read the Arthur and BOT posts.';
  const saved = new Map((data || []).map((row) => [String(row.url || ''), row]));
  const posts = ranked.posts.filter((post) => post.postId && saved.has(`https://fansly.com/post/${post.postId}`)).slice(0, ask.count);
  if (!posts.length) return 'Arthur and BOT posts are saved, but none of them are in the last 30 days of view rankings.';
  const lines = [`Top ${posts.length} Arthur and BOT posts, last 30 days`, ''];
  posts.forEach((post, index) => {
    const row = saved.get(`https://fansly.com/post/${post.postId}`);
    const caption = String(row?.caption || '').trim().split('\n').map((line) => line.trim()).filter(Boolean)[0] || '';
    lines.push(`${index + 1}. ${post.name || row?.username || 'Model'} · ${row?.notes || 'Arthur'}`);
    if (caption) lines.push(caption);
    lines.push(`${row?.day || ''} · ${countLabel(post.views)} views, ${countLabel(post.likes)} likes`.replace(/^ · /, ''));
    lines.push(`https://fansly.com/post/${post.postId}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}

async function answerPosts(question: string) {
  const ask = postAsk(question);
  const ranked = await rankedFanslyPosts(ask.range, ask.model);
  if (ranked.error && !ranked.posts.length) return 'I could not reach Fansly for the post list.';
  if (ask.model && !ranked.matched) return `I couldn't find a model matching "${ask.model}".`;
  const posts = ranked.posts.slice(0, ask.count);
  if (!posts.length) {
    const label = ranked.names.length === 1 ? ranked.names[0] : ask.model;
    return label ? `No ranked posts for ${label} in the ${ask.window}.` : `No ranked posts in the ${ask.window}.`;
  }
  const db = supabaseAdmin();
  const urls = posts.map((post) => post.postId).filter(Boolean).map((id) => `https://fansly.com/post/${id}`);
  const { data } = db && urls.length
    ? await db.from('posts').select('url,caption,notes,poster,day').in('url', urls)
    : { data: [] as { url?: string; caption?: string; notes?: string; poster?: string; day?: string }[] };
  const details = new Map((data || []).map((row) => [String(row.url || ''), row]));
  const names = [...new Set(posts.map((post) => post.name || post.username))];
  const who = names.length === 1 ? names[0] : '';
  const header = ask.count > 1
    ? `Top ${posts.length}${who ? ` for ${who}` : ''}, ${ask.window}`
    : `${who ? `${who}, ` : ''}${ask.window}`;
  return [header, ...posts.map((post, index) => formatRankedPost(post, details.get(post.postId ? `https://fansly.com/post/${post.postId}` : ''), index, posts.length))].join('\n\n');
}

export async function answerQuestion(question: string) {
  const db = supabaseAdmin();
  if (!db) return 'Supabase is not connected.';
  const q = plainQuestion(question);
  const today = manilaKey(new Date());
  if (/earn|net|made|money/.test(q) && !/\bpost/.test(q)) {
    const day = /yesterday/.test(q) ? shiftKey(today, -1) : today;
    const { data } = await db.from('earnings').select('net').eq('day', day);
    const net = (data || []).reduce((sum, row) => sum + (Number(row.net) || 0), 0);
    return `${day}: ${money(net)} net, from the saved Philippine day.`;
  }
  if (/follow|sub/.test(q) && !/\bpost/.test(q)) {
    const { data } = await db.from('audience').select('name,new_subscribers,new_followers,subscribers,followers,day,slot').order('updated_at', { ascending: false }).limit(30);
    if (!data?.length) return 'No subscriber check has been saved yet.';
    const latest = data[0];
    const same = data.filter((row) => row.day === latest.day && row.slot === latest.slot);
    const subs = same.reduce((sum, row) => sum + (Number(row.new_subscribers) || 0), 0);
    const followers = same.reduce((sum, row) => sum + (Number(row.new_followers) || 0), 0);
    return `${latest.day} check: ${subs} new subscribers, ${followers} new followers.`;
  }
  if (wantsArthurPosts(question)) return answerArthurPosts(question);
  if (/\bbest\b|\btop\b|\bpost/.test(q)) return answerPosts(question);
  return 'Ask about the best post, today\'s earnings, or followers. I use the saved Supabase numbers.';
}

export async function handleTelegramUpdate(update: { update_id?: number; message?: { chat?: { id?: number }; text?: string } }) {
  const chatId = update.message?.chat?.id;
  const text = (update.message?.text || '').trim();
  if (!chatId || !text) return;
  rememberChat(chatId);
  if (text === '/start') {
    await telegramSend(chatId, 'Updates arrive at 8:00 AM, 4:00 PM, and 11:59 PM, Philippine time. Send a question on its own. Example: what was the best post for Niya in the last 30 days');
    return;
  }
  const question = text.replace(/^\/ask(?:@\w+)?\s*/i, '').trim();
  if (!question || (text.startsWith('/') && !/^\/ask(?:@\w+)?\b/i.test(text))) {
    await telegramSend(chatId, 'Send a question. Example: what was the best post for Niya in the last 30 days');
    return;
  }
  await telegramSend(chatId, 'Working on it.');
  try {
    await telegramSend(chatId, await answerQuestion(question));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    await telegramSend(chatId, 'I could not answer that just now.');
  }
}
