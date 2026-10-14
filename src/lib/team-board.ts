import { airtableListAll, BASES, TABLES } from './airtable-read';
import { isUnderAge } from './age-guard';
import { loadPlan, loadUsedFiles, loadUsedTos } from './desk-plan';
import { listDriveVideos } from './drive';

export async function loadRoster() {
  const [accounts, chatters, tosRecords, fypPosts] = await Promise.all([
    airtableListAll(BASES.OPS, TABLES.ACCOUNTS),
    airtableListAll(BASES.CLIENT, TABLES.CHATTERS),
    airtableListAll(BASES.TOS, TABLES.TOS),
    airtableListAll(BASES.OPS, TABLES.FYP, { filterByFormula: `{Notes}='BOT'` }),
  ]);

  const plan = loadPlan();
  const usedFiles = loadUsedFiles();
  const usedTos = loadUsedTos();
  const usedFileIds = new Set(usedFiles.map((u: any) => u.id));

  const chatterByName = new Map(chatters.map((c: any) => [c.fields['Category name'] || c.fields.Name, c]));

  const rawRoster = await Promise.all(
    accounts.map(async (acc: any) => {
      const name = acc.fields.Name || '';
      const username = acc.fields['Fansly username'] || '';
      const managedBy = (acc.fields['Managed by'] || '').trim();
      const status = acc.fields.Status || '';
      // Skip offboarded / unassigned
      if (!managedBy || managedBy === '(none)' || managedBy.toLowerCase() === 'none' || managedBy.toLowerCase() === 'offboarded') {
        return null;
      }
      const chatter = chatterByName.get(name);
      const age = chatter?.fields.Age;
      const under21 = isUnderAge(age);
      const folderId = plan.folders[acc.id];
      let filesLeft = 0;
      if (folderId) {
        try {
          const vids = await listDriveVideos(folderId);
          filesLeft = vids.filter((v: any) => !usedFileIds.has(v.id)).length;
        } catch {
          filesLeft = 0;
        }
      }
      const usedForModel = usedTos[acc.id] || [];
      const tosLeft = tosRecords.filter((t: any) => t.fields.TOS && !usedForModel.includes(t.id)).length;
      const postsPerDay = plan.plans[acc.id]?.postsPerDay || 4;
      const needContent = filesLeft < Math.max(6, postsPerDay * 2) || !folderId;
      let flag = '';
      if (under21) flag = 'Skip';
      else if (needContent) flag = 'Ask for more content';
      return {
        id: acc.id,
        name,
        username,
        managedBy,
        status,
        age,
        under21,
        filesLeft,
        tosLeft,
        needContent,
        flag,
        plan: plan.plans[acc.id],
      };
    })
  );

  const roster = rawRoster.filter(Boolean) as any[];

  const managers = roster.reduce((acc: any, m) => {
    const key = m.managedBy || '(none)';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const botPosts = fypPosts.map((p: any) => ({
    id: p.id,
    when: p.fields['Date & Time'],
    account: p.fields['Fansly username'] || '',
    status: p.fields.Status,
    caption: p.fields.Caption || '',
  }));

  return { roster, managers, tosCount: tosRecords.length, botPosts, plan };
}