import fs from 'fs';
import path from 'path';

const STATE = path.join('data', 'supabase-sync-state.json');

function loadEnv() {
  try {
    for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const index = line.indexOf('=');
      const key = line.slice(0, index);
      if (!process.env[key]) process.env[key] = line.slice(index + 1);
    }
  } catch {}
}

function manilaNow() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return { day: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() };
}

function latestSlot(hour) {
  if (hour >= 16) return 16;
  if (hour >= 8) return 8;
  return 0;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
}

const REPORT_SLOTS = [0, 8, 16];

function dueReportSlots(hour) {
  const slots = [0];
  if (hour >= 8) slots.push(8);
  if (hour >= 16) slots.push(16);
  return slots;
}

function slotDone(state, kind, day, slot) {
  const reports = state.reports || {};
  if (reports[`${kind}:${day}:${slot}`]) return true;
  const legacy = String(state[kind] || '');
  const prefix = `${day}-`;
  if (!legacy.startsWith(prefix)) return false;
  const done = Number(legacy.slice(prefix.length));
  const doneAt = REPORT_SLOTS.indexOf(done);
  const want = REPORT_SLOTS.indexOf(slot);
  return doneAt !== -1 && want !== -1 && want <= doneAt;
}

function dueJob(state) {
  const { day, hour } = manilaNow();
  for (const slot of dueReportSlots(hour)) {
    if (!slotDone(state, 'earnings', day, slot)) return `earnings:${slot}`;
    if (!slotDone(state, 'telegram', day, slot)) return `telegram:${slot}`;
  }
  if (process.env.REPORT_ONLY === '1') return '';
  if (slotDone(state, 'telegram', day, 0) && !(state.reports || {})[`sweep:${day}`]) return 'sweep';
  if (hour >= 6 && state.metrics !== day) return 'metrics';
  const slot = latestSlot(hour);
  if (state.slot === `${day}-${slot}`) return '';
  return `slot:${slot}`;
}

function reportId(job) {
  const { day } = manilaNow();
  if (job === 'sweep') return `sweep:${day}`;
  if (job === 'metrics') return `metrics:${day}`;
  const text = String(job);
  if (text.startsWith('earnings:') || text.startsWith('telegram:')) {
    const kind = text.startsWith('earnings:') ? 'earnings' : 'telegram';
    return `${kind}:${day}:${text.slice(kind.length + 1)}`;
  }
  return '';
}

async function reportDb() {
  const { supabaseAdmin } = await import('../src/lib/supabase.ts');
  const client = supabaseAdmin();
  if (!client) throw new Error('Supabase is not configured');
  return client;
}

async function hydrateState() {
  const state = readState();
  state.reports = state.reports || {};
  try {
    const client = await reportDb();
    const { data, error } = await client.from('report_sends').select('id,status').eq('status', 'sent');
    if (error) throw new Error(error.message);
    for (const row of data || []) state.reports[row.id] = true;
  } catch (error) {
    console.error(`Report state: ${error instanceof Error ? error.message : error}`);
  }
  return state;
}

const CLAIM_MS = 20 * 60 * 1000;

async function claimReport(id, attempt = 0) {
  const client = await reportDb();
  const now = new Date().toISOString();
  const inserted = await client.from('report_sends').insert({ id, status: 'claimed', updated_at: now });
  if (!inserted.error) return true;
  if (String(inserted.error.message || '').includes('schema cache') && attempt < 4) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return claimReport(id, attempt + 1);
  }
  if (inserted.error.code !== '23505') throw new Error(inserted.error.message);
  const { data, error } = await client.from('report_sends').select('status,updated_at').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.status === 'sent') return false;
  if (Date.now() - new Date(data.updated_at).getTime() < CLAIM_MS) return false;
  const cutoff = new Date(Date.now() - CLAIM_MS).toISOString();
  const taken = await client.from('report_sends').update({ status: 'claimed', updated_at: now }).eq('id', id).neq('status', 'sent').lt('updated_at', cutoff).select('id');
  if (taken.error) throw new Error(taken.error.message);
  return Boolean(taken.data?.length);
}

async function releaseReport(id) {
  const client = await reportDb();
  await client.from('report_sends').delete().eq('id', id).eq('status', 'claimed');
}

async function mark(job) {
  const { day, hour } = manilaNow();
  const state = readState();
  if (job === 'metrics') state.metrics = day;
  else if (job === 'sweep') {
    state.reports = state.reports || {};
    state.reports[`sweep:${day}`] = true;
  } else if (String(job).startsWith('earnings:') || String(job).startsWith('telegram:')) {
    const kind = String(job).startsWith('earnings:') ? 'earnings' : 'telegram';
    const slot = job.slice(kind.length + 1);
    state.reports = state.reports || {};
    state.reports[`${kind}:${day}:${slot}`] = true;
    state[kind] = `${day}-${slot}`;
  } else if (String(job).startsWith('slot:')) state.slot = `${day}-${job.slice(5)}`;
  else state.slot = `${day}-${latestSlot(hour)}`;
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(state));
  const id = reportId(job);
  if (!id) return;
  const client = await reportDb();
  const { error } = await client.from('report_sends').upsert({ id, status: 'sent', updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

loadEnv();
const state = await hydrateState();
const asked = process.argv[2] || 'auto';
let job = asked === 'auto' ? dueJob(state) : asked;
if (process.env.REPORT_ONLY === '1' && job && !String(job).startsWith('earnings:') && !String(job).startsWith('telegram:')) job = '';
if (!job) process.exit(0);
const ownedId = reportId(job);
if (ownedId && (state.reports || {})[ownedId]) process.exit(0);
if (ownedId && !(await claimReport(ownedId))) process.exit(0);

const lock = path.join('data', 'supabase-sync.lock');
if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs < 20 * 60 * 1000) process.exit(0);
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(lock, String(Date.now()));
try {
  const { syncJob, syncPostMetrics, syncSlot } = await import('../src/lib/supabase-sync.ts');
  if (job === 'metrics') await syncPostMetrics();
  else if (String(job).startsWith('slot:')) await syncSlot(Number(job.slice(5)));
  else if (String(job).startsWith('earnings:')) {
    const slot = Number(job.slice('earnings:'.length));
    const { closeShiftEarnings } = await import('../src/lib/shift-earnings.ts');
    const { closeShiftSubs } = await import('../src/lib/shift-subs.ts');
    await closeShiftEarnings(slot);
    await closeShiftSubs(slot);
  } else if (job === 'sweep') {
    const { remeasureRecentEarnings } = await import('../src/lib/shift-earnings.ts');
    await remeasureRecentEarnings();
  } else if (String(job).startsWith('telegram:')) {
    const slot = Number(job.slice('telegram:'.length));
    const { sendOwnerUpdate } = await import('../src/lib/telegram-desk.ts');
    await sendOwnerUpdate(slot);
  } else await syncJob(job === 'all' ? 'all' : job);
  await mark(job);
  fs.rmSync(path.join('data', 'supabase-read-cache.json'), { force: true });
  console.error(`Supabase ${job} sync finished`);
} catch (error) {
  if (ownedId) await releaseReport(ownedId).catch(() => {});
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
} finally {
  fs.rmSync(lock, { force: true });
}
