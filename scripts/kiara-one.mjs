import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { google } from 'googleapis';

const TOKEN = fs.readFileSync('data/secrets/airtable-token.txt', 'utf8').trim();
const SA = JSON.parse(fs.readFileSync('data/secrets/google-service-account.json', 'utf8'));
const ACCOUNT_ID = 'receOFDGZ0s5LgA9T';
const OPS = 'appHWOLnUidK3K9dA';
const TOS_BASE = 'appsAEWeNQSCYLDpl';

function extractFolderId(link) {
  if (!link) return null;
  const s = String(link).trim();
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s) && !s.includes('/')) return s;
  const m = s.match(/\/folders\/([a-zA-Z0-9_-]+)/) || s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

async function airtable(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('close', code => (code === 0 ? resolve(null) : reject(new Error('ffmpeg fail'))));
  });
}

async function main() {
  // Get Drive folder from the new "Drive link (Bot)" column
  const accData = await airtable('GET', `https://api.airtable.com/v0/${OPS}/Accounts/${ACCOUNT_ID}`);
  const driveLink = accData.fields['Drive link (Bot)'] || '';
  const FOLDER = extractFolderId(driveLink) || '1KyoYeWom-lsVzPgWVEHy24CVRL3K3C0p';
  console.log('Using Drive folder:', FOLDER);

  // List unused TOS
  const tosData = await airtable('GET', `https://api.airtable.com/v0/${TOS_BASE}/Table%201`);
  const tosList = tosData.records.filter(r => r.fields.TOS);
  // Load used
  let used = [];
  try { used = JSON.parse(fs.readFileSync('data/used-drive-files.json', 'utf8')); } catch {}
  const usedIds = new Set(used.map(u => u.id));
  const usedTos = new Set(used.map(u => u.tosId));

  const auth = new google.auth.GoogleAuth({ credentials: SA, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  const drive = google.drive({ version: 'v3', auth: await auth.getClient() });
  const filesRes = await drive.files.list({
    q: `'${FOLDER}' in parents and trashed=false`,
    fields: 'files(id,name,size)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const unused = (filesRes.data.files || []).filter(f => !usedIds.has(f.id) && f.size < 12000000);
  if (!unused.length) { console.log('No unused files'); return; }
  const file = unused[Math.floor(Math.random() * unused.length)];
  const tos = tosList.find(t => !usedTos.has(t.id));
  if (!tos) { console.log('No unused TOS'); return; }

  const tmp = `/tmp/${file.id}.mp4`;
  const dest = fs.createWriteStream(tmp);
  await new Promise((resolve, reject) => {
    drive.files.get({ fileId: file.id, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' })
      .then(res => res.data.pipe(dest).on('finish', resolve).on('error', reject));
  });

  // Simple overlay (full recipe omitted for brevity; expand as needed)
  const out = `/tmp/out-${Date.now()}.mp4`;
  await run('ffmpeg', ['-i', tmp, '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text=TOS:fontsize=64:fontcolor=white:borderw=10:bordercolor=black:x=(w-text_w)/2:y=h*0.72', '-t', '5', '-c:v', 'libx264', '-crf', '19', '-y', out]);

  // Create Airtable row
  const rec = await airtable('POST', `https://api.airtable.com/v0/${OPS}/FYP%20Posts`, {
    records: [{
      fields: {
        Creator: [ACCOUNT_ID],
        Account: [ACCOUNT_ID],
        Caption: tos.fields['Caption + #'] || '',
        Type: 'Solo',
        'Date & Time': new Date().toISOString(),
        Status: 'Draft',
        'Post method': 'Bot',
        'Post to FYP': true,
        Notes: 'BOT',
      },
    }],
    typecast: true,
  });
  const recordId = rec.records[0].id;

  // Upload attachment
  const b64 = fs.readFileSync(out).toString('base64');
  await fetch(`https://content.airtable.com/v0/${OPS}/${recordId}/Media/uploadAttachment`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: 'video/mp4', file: b64, filename: 'clip.mp4' }),
  });

  // Ready
  await airtable('PATCH', `https://api.airtable.com/v0/${OPS}/FYP%20Posts/${recordId}`, {
    fields: { Status: 'Ready', Notes: 'BOT' },
    typecast: true,
  });

  used.push({ id: file.id, name: file.name, tosId: tos.id, recordId, usedAt: new Date().toISOString() });
  fs.writeFileSync('data/used-drive-files.json', JSON.stringify(used, null, 2));
  console.log('Done', recordId);
}

main().catch(console.error);