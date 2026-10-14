'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginForm() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch('/api/board/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      router.refresh();
    } else {
      setError('Wrong password');
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 text-white">
      <form onSubmit={onSubmit} className="space-y-4 p-8 border border-zinc-800 rounded-lg w-80">
        <h1 className="text-2xl font-bold">FYP Board</h1>
        <input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="Password" className="w-full p-2 bg-zinc-900 border border-zinc-700 rounded" required />
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button type="submit" className="w-full p-2 bg-blue-600 rounded">Enter</button>
      </form>
    </div>
  );
}