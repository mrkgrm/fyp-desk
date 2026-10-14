import { loadRoster } from '@/lib/team-board';
import BoardClient from './BoardClient';

export default async function BoardPage() {
  const data = await loadRoster();
  return <BoardClient data={data} />;
}