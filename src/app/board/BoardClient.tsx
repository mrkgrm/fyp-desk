'use client';

import { useState } from 'react';

export default function BoardClient({ data }: { data: any }) {
  const { roster, managers, tosCount, botPosts, plan } = data;
  const [tab, setTab] = useState<'board' | 'admin'>('board');
  const [selected, setSelected] = useState(roster.find((r: any) => r.name.includes('Kiara')) || roster[0]);
  const [postsPerDay, setPostsPerDay] = useState(selected?.plan?.postsPerDay || 4);
  const [startTime, setStartTime] = useState(selected?.plan?.startTime || '05:00');
  const [interval, setInterval] = useState(selected?.plan?.intervalMinutes || 60);
  const [filter, setFilter] = useState('All');
  const [adminNotes, setAdminNotes] = useState('');
  const [scheduling, setScheduling] = useState(false);

  const filtered = roster.filter((r: any) => {
    if (filter === 'Bot') return r.managedBy === 'Bot';
    if (filter === 'Active') return r.status === 'Active';
    if (filter === 'Need content') return r.needContent;
    return true;
  });

  async function saveSchedule() {
    await fetch('/api/board/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: selected.id,
        postsPerDay,
        startTime,
        intervalMinutes: interval,
      }),
    });
    alert('Saved');
  }

  async function generateAllSchedules() {
    setScheduling(true);
    try {
      // Generate slots for every managed model based on their plan
      for (const model of roster) {
        if (model.under21 || model.flag === 'Skip') continue;
        const p = model.plan || { postsPerDay: 4, startTime: '05:00', intervalMinutes: 60 };
        // In a real worker this would queue clips; here we just mark the plan as active
        await fetch('/api/board/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId: model.id,
            postsPerDay: p.postsPerDay || 4,
            startTime: p.startTime || '05:00',
            intervalMinutes: p.intervalMinutes || 60,
          }),
        });
      }
      alert(`Scheduling complete for ${roster.length} managed models`);
    } catch (e) {
      alert('Scheduling failed');
    } finally {
      setScheduling(false);
    }
  }

  function saveAdminNote() {
    // Store locally for now; can be wired to Airtable Notes later
    const notes = JSON.parse(localStorage.getItem('fyp_admin_notes') || '[]');
    notes.unshift({ text: adminNotes, at: new Date().toISOString() });
    localStorage.setItem('fyp_admin_notes', JSON.stringify(notes.slice(0, 50)));
    setAdminNotes('');
    alert('Instruction saved');
  }

  const savedNotes = typeof window !== 'undefined' ? JSON.parse(localStorage.getItem('fyp_admin_notes') || '[]') : [];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">FYP Ops Board</h1>
        <div className="flex gap-2">
          <button onClick={() => setTab('board')} className={`px-4 py-2 rounded ${tab === 'board' ? 'bg-blue-600' : 'bg-zinc-800'}`}>Board</button>
          <button onClick={() => setTab('admin')} className={`px-4 py-2 rounded ${tab === 'admin' ? 'bg-blue-600' : 'bg-zinc-800'}`}>Admin</button>
        </div>
      </div>

      {tab === 'admin' ? (
        <section className="bg-zinc-900 p-6 rounded space-y-4">
          <h2 className="text-xl">Admin Instructions & Updates</h2>
          <textarea
            value={adminNotes}
            onChange={e => setAdminNotes(e.target.value)}
            placeholder="Write instructions, notes, or updates for the team..."
            className="w-full h-32 bg-zinc-800 p-3 rounded text-sm"
          />
          <button onClick={saveAdminNote} className="bg-blue-600 px-4 py-2 rounded">Save instruction</button>
          <div className="space-y-2 mt-4">
            {savedNotes.map((n: any, i: number) => (
              <div key={i} className="bg-zinc-800 p-3 rounded text-sm">
                <div className="text-zinc-400 text-xs">{new Date(n.at).toLocaleString()}</div>
                <div>{n.text}</div>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <>
          <div className="flex justify-between items-center">
            <div className="grid grid-cols-4 gap-4 flex-1">
              <Stat label="Models" value={roster.length} />
              <Stat label="Bot accounts" value={roster.filter((r: any) => r.managedBy === 'Bot').length} />
              <Stat label="Need content" value={roster.filter((r: any) => r.needContent).length} />
              <Stat label="TOS in bank" value={tosCount} />
            </div>
            <button
              onClick={generateAllSchedules}
              disabled={scheduling}
              className="ml-4 bg-green-600 hover:bg-green-500 disabled:opacity-50 px-6 py-3 rounded font-semibold"
            >
              {scheduling ? 'Scheduling…' : 'Generate all schedules'}
            </button>
          </div>

          <section>
            <h2 className="text-xl mb-2">Who manages who</h2>
            <div className="flex gap-4 flex-wrap">
              {Object.entries(managers).map(([k, v]) => (
                <div key={k} className="bg-zinc-900 p-3 rounded">{k}: {v as number}</div>
              ))}
            </div>
          </section>

          <section className="bg-zinc-900 p-4 rounded">
            <h2 className="text-xl mb-2">Schedule — {selected?.name}</h2>
            <div className="flex gap-4 items-end">
              <label>Posts/day
                <input type="number" min={1} max={14} value={postsPerDay} onChange={e => setPostsPerDay(+e.target.value)} className="block bg-zinc-800 p-1 rounded w-20" />
              </label>
              <label>First post
                <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} className="block bg-zinc-800 p-1 rounded" />
              </label>
              <label>Interval
                <select value={interval} onChange={e => setInterval(+e.target.value)} className="block bg-zinc-800 p-1 rounded">
                  <option value={30}>30</option>
                  <option value={60}>60</option>
                  <option value={90}>90</option>
                  <option value={120}>120</option>
                </select>
              </label>
              <button onClick={saveSchedule} className="bg-blue-600 px-4 py-2 rounded">Save schedule</button>
            </div>
            <p className={`mt-2 text-sm ${selected?.needContent ? 'text-red-400 font-semibold' : 'text-zinc-400'}`}>
              Clips left: {selected?.filesLeft} · TOS left: {selected?.tosLeft} · {selected?.flag}
            </p>
          </section>

          <section>
            <div className="flex gap-2 mb-2">
              {['All', 'Bot', 'Active', 'Need content'].map(f => (
                <button key={f} onClick={() => setFilter(f)} className={`px-3 py-1 rounded ${filter === f ? 'bg-blue-600' : 'bg-zinc-800'}`}>{f}</button>
              ))}
            </div>
            <table className="w-full text-sm">
              <thead><tr className="text-left border-b border-zinc-800"><th>Model</th><th>Username</th><th>Managed by</th><th>Status</th><th>Clips left</th><th>TOS left</th><th>Flag</th></tr></thead>
              <tbody>
                {filtered.map((r: any) => (
                  <tr
                    key={r.id}
                    className={`border-b border-zinc-900 hover:bg-zinc-900 cursor-pointer ${r.needContent ? 'bg-red-950/40 text-red-200' : ''}`}
                    onClick={() => setSelected(r)}
                  >
                    <td>{r.name}</td><td>{r.username}</td><td>{r.managedBy}</td><td>{r.status}</td>
                    <td>{r.filesLeft}</td><td>{r.tosLeft}</td><td className={r.needContent ? 'text-red-400 font-semibold' : ''}>{r.flag}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h2 className="text-xl mb-2">Queued BOT posts</h2>
            <table className="w-full text-sm">
              <thead><tr className="text-left"><th>When (Manila)</th><th>Account</th><th>Status</th><th>Caption</th></tr></thead>
              <tbody>
                {botPosts.map((p: any) => (
                  <tr key={p.id} className="border-b border-zinc-900">
                    <td>{p.when ? new Date(p.when).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : ''}</td>
                    <td>{p.account}</td><td>{p.status}</td><td className="max-w-xs truncate">{p.caption}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-zinc-900 p-4 rounded">
      <div className="text-sm text-zinc-400">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}
