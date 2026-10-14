import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const PASS_PATH = path.join(process.cwd(), 'data/secrets/board-password.txt');
const PASSWORD = process.env.TEAM_BOARD_PASSWORD || (fs.existsSync(PASS_PATH) ? fs.readFileSync(PASS_PATH, 'utf8').trim() : 'FypBoard-Kiara');

function hmac(pass: string) {
  return crypto.createHmac('sha256', pass).update('fyp-board').digest('hex');
}

export async function POST(req: NextRequest) {
  const { password } = await req.json();
  if (password === PASSWORD) {
    const token = hmac(PASSWORD);
    const res = NextResponse.json({ ok: true });
    res.cookies.set('fyp_board', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 30,
    });
    return res;
  }
  return NextResponse.json({ ok: false }, { status: 401 });
}