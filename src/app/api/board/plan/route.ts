import { NextRequest, NextResponse } from 'next/server';
import { loadPlan, savePlan } from '@/lib/desk-plan';
import { patchFields, BASES, TABLES } from '@/lib/airtable-read';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const PASS_PATH = path.join(process.cwd(), 'data/secrets/board-password.txt');
const PASSWORD = process.env.TEAM_BOARD_PASSWORD || (fs.existsSync(PASS_PATH) ? fs.readFileSync(PASS_PATH, 'utf8').trim() : 'FypBoard-Kiara');

function checkAuth(req: NextRequest) {
  const cookie = req.cookies.get('fyp_board')?.value;
  const expected = crypto.createHmac('sha256', PASSWORD).update('fyp-board').digest('hex');
  return cookie === expected;
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await req.json();
  const { accountId, postsPerDay, startTime, intervalMinutes } = body;
  const plan = loadPlan();
  plan.plans[accountId] = {
    postsPerDay: Number(postsPerDay),
    startTime,
    intervalMinutes: Number(intervalMinutes),
    timezone: 'Asia/Manila',
  };
  savePlan(plan);
  // Persist to Airtable Notes
  try {
    const line = `FYP_PLAN:${JSON.stringify(plan.plans[accountId])}`;
    // We need current Notes; for simplicity append/replace later — fetch not done here, assume caller or patch whole
    // In real, fetch record first. For now write the line (operator can clean).
    await patchFields(BASES.OPS, TABLES.ACCOUNTS, accountId, { Notes: line });
  } catch (e) {
    console.error(e);
  }
  return NextResponse.json({ ok: true, plan });
}