import fs from 'fs';
import path from 'path';

const TOKEN_PATH = path.join(process.cwd(), 'data/secrets/airtable-token.txt');
const TOKEN = process.env.AIRTABLE_TOKEN || (fs.existsSync(TOKEN_PATH) ? fs.readFileSync(TOKEN_PATH, 'utf8').trim() : '');

export const BASES = {
  TOS: 'appsAEWeNQSCYLDpl',
  OPS: 'appHWOLnUidK3K9dA',
  CLIENT: 'appwusXev11Tcip1n',
  CRM: 'appn6eBMkVoEeueOv',
};

export const TABLES = {
  TOS: 'Table 1',
  ACCOUNTS: 'Accounts',
  FYP: 'FYP Posts',
  CHATTERS: 'Model Details for Chatters',
};

export async function airtableFetch(base: string, table: string, params: Record<string, string> = {}) {
  const url = new URL(`https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function airtableListAll(base: string, table: string, params: Record<string, string> = {}) {
  let records: any[] = [];
  let offset: string | undefined;
  do {
    const p = { ...params };
    if (offset) p.offset = offset;
    const data = await airtableFetch(base, table, p);
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}

export async function patchFields(base: string, table: string, id: string, fields: Record<string, any>) {
  const res = await fetch(`https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}/${id}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!res.ok) throw new Error(`Patch ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function createRecord(base: string, table: string, fields: Record<string, any>) {
  const res = await fetch(`https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  });
  if (!res.ok) throw new Error(`Create ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.records[0];
}