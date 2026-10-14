import { cookies } from 'next/headers';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { loadRoster } from '@/lib/team-board';
import BoardClient from './BoardClient';
import LoginForm from './LoginForm';

const PASS_PATH = path.join(process.cwd(), 'data/secrets/board-password.txt');
const PASSWORD = process.env.TEAM_BOARD_PASSWORD || (fs.existsSync(PASS_PATH) ? fs.readFileSync(PASS_PATH, 'utf8').trim() : 'FypBoard-Kiara');

function isAuthed() {
  const jar = cookies();
  const cookie = jar.get('fyp_board')?.value;
  const expected = crypto.createHmac('sha256', PASSWORD).update('fyp-board').digest('hex');
  return cookie === expected;
}

export default async function BoardPage() {
  if (!isAuthed()) {
    return <LoginForm />;
  }
  const data = await loadRoster();
  return <BoardClient data={data} />;
}