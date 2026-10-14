import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

const SA_PATH = path.join(process.cwd(), 'data/secrets/google-service-account.json');
let auth: any;

function getAuth() {
  if (auth) return auth;
  const creds = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    : JSON.parse(fs.readFileSync(SA_PATH, 'utf8'));
  auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return auth;
}

export async function listDriveVideos(folderId: string) {
  const authClient = await getAuth().getClient();
  const drive = google.drive({ version: 'v3', auth: authClient });
  const files: any[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id, name, mimeType, size)',
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageToken,
    });
    const vids = (res.data.files || []).filter((f: any) =>
      f.mimeType?.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(f.name || '')
    );
    files.push(...vids);
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);
  return files;
}

export async function downloadDriveFile(fileId: string, destPath: string) {
  const authClient = await getAuth().getClient();
  const drive = google.drive({ version: 'v3', auth: authClient });
  const dest = fs.createWriteStream(destPath);
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  );
  return new Promise((resolve, reject) => {
    res.data
      .on('end', () => resolve(destPath))
      .on('error', reject)
      .pipe(dest);
  });
}