'use client';

import { useState, useRef } from 'react';

type Job = { id: string; name: string; count: number; done: number; status: 'queued' | 'running' | 'done' | 'cancelled' | 'error' };

export default function BoardClient({ data }: { data: any }) {
  const { roster, managers, tosCount, botPosts } = data;
  const [tab, setTab] = useState<'board' | 'admin'>('board');
  const [selected, setSelected] = useState(roster[0]);
  const [postsPerDay, setPostsPerDay] = useState(selected?.plan?.postsPerDay || 4);
  const [startTime, setStartTime] = useState(selected?.plan?.startTime || '05:00');
  const [interval, setInterval] = useState(selected?.plan?.intervalMinutes || 60);
  const [filter, setFilter] = useState('All');
  const [adminNotes, setAdminNotes] = useState('');
  const [counts, setCounts] = useState<Record<string, number>>(() =>
    Object.fromEntries(roster.map((r: any) => [r.id, 1]))
  );
  const [bulkCount, setBulkCount] = useState(1);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [running, setRunning] = useState(false);
  const abortRef = useRef(false);

  const filtered = roster.filter((r: any) => {
    if (filter === 'Bot') return r.managedBy === 'Bot';
    if (filter === 'Active') return r.status === 'Active';
    if (filter === 'Need content') return r.needContent;
    return true;
  });

  function setAllCounts(n: number) {
    setCounts(Object.fromEntries(roster.map((r: any) => [r.id, n])));
  }

  async function saveSchedule() {
    await fetch('/api/board/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: selected.id, postsPerDay, startTime, intervalMinutes: interval }),
    });
    alert('Saved');
  }

  async function createContent() {
    const targets = filtered.filter((r: any) => (counts[r.id] || 0) > 0);
    if (!targets.length) return alert('Set a count > 0 for at least one model');
    abortRef.current = false;
    setRunning(true);
    const newJobs: Job[] = targets.map((r: any) => ({
      id: r.id,
      name: r.name,
      count: counts[r.id] || 1,
      done: 0,
      status: 'queued',
    }));
    setJobs(newJobs);

    for (let i = 0; i < newJobs.length; i++) {
      if (abortRef.current) {
        setJobs(prev => prev.map(j => j.status === 'queued' || j.status === 'running' ? { ...j, status: 'cancelled' } : j));
        break;
      }
      setJobs(prev => prev.map(j => j.id === newJobs[i].id ? { ...j, status: 'running' } : j));
      // Simulate / call worker (replace with real API later)
      for (let c = 0; c < newJobs[i].count; c++) {
        if (abortRef.current) break;
        await new Promise(r => setTimeout(r, 800));
        setJobs(prev => prev.map(j => j.id === newJobs[i].id ? { ...j, done: c + 1 } : j));
      }
      setJobs(prev => prev.map(j => j.id === newJobs[i].id ? { ...j, status: abortRef.current ? 'cancelled' : 'done' } : j));
    }
    setRunning(false);
  }

  function cancel() {
    abortRef.current = true;
  }

  const totalDone = jobs.reduce((a, j) => a + j.done, 0);
  const totalWanted = jobs.reduce((a, j) => a + j.count, 0);
  const pct = totalWanted ? Math.round((totalDone / totalWanted) * 100) : 0;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">FYP Ops Board</h1>
        <div className="flex gap-2">
          <button onClick={() => setTab('board')} className={`px-4 py-2 rounded transition ${tab === 'board' ? 'bg-blue-600' : 'bg-zinc-800 hover:bg-zinc-700'}`}>Board</button>
          <button onClick={() => setTab('admin')} className={`px-4 py-2 rounded transition ${tab === 'admin' ? 'bg-blue-600' : 'bg-zinc-800 hover:bg-zinc-700'}`}>Admin</button>
        </div>
      </div>

      {tab === 'admin' ? (
        <section className="bg-zinc-900 p-6 rounded space-y-4">
          <h2 className="text-xl">Admin Instructions & Updates</h2>
          <textarea value={adminNotes} onChange={e => setAdminNotes(e.target.value)} placeholder="Write instructions..." className="w-full h-32 bg-zinc-800 p-3 rounded text-sm" />
          <button onClick={() => { const notes = JSON.parse(localStorage.getItem('fyp_admin_notes') || '[]'); notes.unshift({ text: adminNotes, at: new Date().toISOString() }); localStorage.setItem('fyp_admin_notes', JSON.stringify(notes.slice(0, 50))); setAdminNotes(''); alert('Saved'); }} className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded transition">Save instruction</button>
        </section>
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-4 gap-4">
            <Stat label="Models" value={roster.length} />
            <Stat label="Bot accounts" value={roster.filter((r: any) => r.managedBy === 'Bot').length} />
            <Stat label="Need content" value={roster.filter((r: any) => r.needContent).length} />
            <Stat label="TOS in bank" value={tosCount} />
          </div>

          {/* Create content panel — top, visual */}
          <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h2 className="text-xl font-semibold">Create content</h2>
              <div className="flex items-center gap-2">
                <span className="text-sm text-zinc-400">Set all to</span>
                <input type="number" min={0} max={20} value={bulkCount} onChange={e => setBulkCount(+e.target.value)} className="w-16 bg-zinc-800 p-1 rounded text-center" />
                <button onClick={() => setAllCounts(bulkCount)} className="bg-zinc-700 hover:bg-zinc-600 px-3 py-1 rounded text-sm transition">Apply</button>
              </div>
            </div>

            <div className="grid gap-2 max-h-64 overflow-auto pr-2">
              {filtered.map((r: any) => (
                <div key={r.id} className={`flex items-center justify-between p-3 rounded-lg ${r.needContent ? 'bg-red-950/50 border border-red-900' : 'bg-zinc-800'}`}>
                  <div className="flex items-center gap-3">
                    <input type="checkbox" checked={(counts[r.id] || 0) > 0} onChange={e => setCounts({ ...counts, [r.id]: e.target.checked ? (counts[r.id] || 1) : 0 })} className="accent-purple-500" />
                    <div>
                      <div className="font-medium">{r.name}</div>
                      <div className="text-xs text-zinc-400">{r.username} · {r.managedBy} · {r.filesLeft} clips left</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500">videos</span>
                    <input
                      type="number"
                      min={0}
                      max={20}
                      value={counts[r.id] ?? 1}
                      onChange={e => setCounts({ ...counts, [r.id]: Math.max(0, +e.target.value) })}
                      className="w-16 bg-zinc-900 p-1 rounded text-center"
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-3 items-center pt-2">
              <button
                onClick={createContent}
                disabled={running}
                className="bg-purple-600 hover:bg-purple-500 disabled:opacity-50 px-6 py-3 rounded-lg font-semibold transition active:scale-95"
              >
                {running ? 'Creating…' : 'Create content'}
              </button>
              {running && (
                <button onClick={cancel} className="bg-red-600 hover:bg-red-500 px-4 py-3 rounded-lg font-semibold transition active:scale-95">
                  Cancel
                </button>
              )}
              <span className="text-sm text-zinc-400">
                {Object.values(counts).filter(n => n > 0).length} models · {Object.values(counts).reduce((a, b) => a + b, 0)} videos total
              </span>
            </div>

            {/* Progress */}
            {jobs.length > 0 && (
              <div className="space-y-3 pt-2 border-t border-zinc-800">
                <div className="flex justify-between text-sm">
                  <span>Progress</span>
                  <span>{totalDone} / {totalWanted} ({pct}%)</span>
                </div>
                <div className="h-3 bg-zinc-800 rounded-full overflow-hidden">
                  <div className="h-full bg-purple-500 transition-all" style={{ width: `${pct}%` }} />
                </div>
                <div className="space-y-1 max-h-40 overflow-auto text-sm">
                  {jobs.map(j => (
                    <div key={j.id} className="flex justify-between">
                      <span>{j.name}</span>
                      <span className={j.status === 'done' ? 'text-green-400' : j.status === 'cancelled' ? 'text-red-400' : j.status === 'running' ? 'text-yellow-400' : 'text-zinc-400'}>
                        {j.done}/{j.count} · {j.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Who manages who */}
          <section>
            <h2 className="text-xl mb-2">Who manages who</h2>
            <div className="flex gap-3 flex-wrap">
              {Object.entries(managers).map(([k, v]) => (
                <div key={k} className="bg-zinc-900 px-4 py-2 rounded">{k}: {v as number}</div>
              ))}
            </div>
          </section>

          {/* Schedule editor */}
          <section className="bg-zinc-900 p-4 rounded-xl">
            <h2 className="text-xl mb-3">Schedule — {selected?.name}</h2>
            <div className="flex gap-4 items-end flex-wrap">
              <label>Posts/day
                <input type="number" min={1} max={14} value={postsPerDay} onChange={e => setPostsPerDay(+e.target.value)} className="block bg-zinc-800 p-1 rounded w-20 mt-1" />
              </label>
              <label>First post
                <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} className="block bg-zinc-800 p-1 rounded mt-1" />
              </label>
              <label>Interval
                <select value={interval} onChange={e => setInterval(+e.target.value)} className="block bg-zinc-800 p-1 rounded mt-1">
                  <option value={30}>30</option><option value={60}>60</option><option value={90}>90</option><option value={120}>120</option>
                </select>
              </label>
              <button onClick={saveSchedule} className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded transition active:scale-95">Save schedule</button>
            </div>
            <p className={`mt-3 text-sm ${selected?.needContent ? 'text-red-400 font-semibold' : 'text-zinc-400'}`}>
              Clips left: {selected?.filesLeft} · TOS left: {selected?.tosLeft} · {selected?.flag}
            </p>
          </section>

          {/* Filters + table */}
          <section>
            <div className="flex gap-2 mb-3">
              {['All', 'Bot', 'Active', 'Need content'].map(f => (
                <button key={f} onClick={() => setFilter(f)} className={`px-3 py-1 rounded transition ${filter === f ? 'bg-blue-600' : 'bg-zinc-800 hover:bg-zinc-700'}`}>{f}</button>
              ))}
            </div>
            <table className="w-full text-sm">
              <thead><tr className="text-left border-b border-zinc-800"><th>Model</th><th>Username</th><th>Managed by</th><th>Status</th><th>Clips left</th><th>TOS left</th><th>Flag</th></tr></thead>
              <tbody>
                {filtered.map((r: any) => (
                  <tr key={r.id} onClick={() => setSelected(r)} className={`border-b border-zinc-900 hover:bg-zinc-900 cursor-pointer ${r.needContent ? 'bg-red-950/40 text-red-200' : ''}`}>
                    <td className="py-2">{r.name}</td><td>{r.username}</td><td>{r.managedBy}</td><td>{r.status}</td>
                    <td>{r.filesLeft}</td><td>{r.tosLeft}</td><td className={r.needContent ? 'text-red-400 font-semibold' : ''}>{r.flag}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* Queued posts */}
          <section>
            <h2 className="text-xl mb-2">Queued BOT posts</h2>
            <table className="w-full text-sm">
              <thead><tr className="text-left"><th>When (Manila)</th><th>Account</th><th>Status</th><th>Caption</th></tr></thead>
              <tbody>
                {botPosts.map((p: any) => (
                  <tr key={p.id} className="border-b border-zinc-900">
                    <td className="py-1">{p.when ? new Date(p.when).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : ''}</td>
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
    <div className="bg-zinc-900 p-4 rounded-xl">
      <div className="text-sm text-zinc-400">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}
