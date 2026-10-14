import fs from 'fs';
import path from 'path';

const PLAN_PATH = path.join(process.cwd(), 'data/desk-plan.json');
const USED_FILES_PATH = path.join(process.cwd(), 'data/used-drive-files.json');
const USED_TOS_PATH = path.join(process.cwd(), 'data/used-tos.json');

export interface Plan {
  postsPerDay: number;
  startTime: string;
  intervalMinutes: number;
  timezone: string;
}

export interface DeskPlan {
  folders: Record<string, string>;
  plans: Record<string, Plan>;
}

const DEFAULT_PLAN: DeskPlan = {
  folders: {
    receOFDGZ0s5LgA9T: '1KyoYeWom-lsVzPgWVEHy24CVRL3K3C0p',
  },
  plans: {
    receOFDGZ0s5LgA9T: {
      postsPerDay: 4,
      startTime: '05:00',
      intervalMinutes: 60,
      timezone: 'Asia/Manila',
    },
  },
};

export function loadPlan(): DeskPlan {
  try {
    if (fs.existsSync(PLAN_PATH)) {
      return { ...DEFAULT_PLAN, ...JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8')) };
    }
  } catch {}
  return DEFAULT_PLAN;
}

export function savePlan(plan: DeskPlan) {
  fs.mkdirSync(path.dirname(PLAN_PATH), { recursive: true });
  fs.writeFileSync(PLAN_PATH, JSON.stringify(plan, null, 2));
}

export function loadUsedFiles(): any[] {
  try {
    if (fs.existsSync(USED_FILES_PATH)) return JSON.parse(fs.readFileSync(USED_FILES_PATH, 'utf8'));
  } catch {}
  return [];
}

export function saveUsedFiles(items: any[]) {
  fs.mkdirSync(path.dirname(USED_FILES_PATH), { recursive: true });
  fs.writeFileSync(USED_FILES_PATH, JSON.stringify(items, null, 2));
}

export function loadUsedTos(): Record<string, string[]> {
  try {
    if (fs.existsSync(USED_TOS_PATH)) return JSON.parse(fs.readFileSync(USED_TOS_PATH, 'utf8'));
  } catch {}
  return {};
}

export function saveUsedTos(data: Record<string, string[]>) {
  fs.mkdirSync(path.dirname(USED_TOS_PATH), { recursive: true });
  fs.writeFileSync(USED_TOS_PATH, JSON.stringify(data, null, 2));
}