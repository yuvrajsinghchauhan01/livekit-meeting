"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

function generateRoomId() {
  // e.g. "meet-x4k2-p9qr"
  const seg = () => Math.random().toString(36).slice(2, 6);
  return `meet-${seg()}-${seg()}`;
}

export default function HomePage() {
  const router = useRouter();
  const [name, setName]       = useState("");
  const [loading, setLoading] = useState(false);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [roomSlug, setRoomSlug]   = useState<string | null>(null);
  const [copied, setCopied]       = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);

    const slug = generateRoomId();

    try {
      const res = await fetch("/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName: slug, participantName: name.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      sessionStorage.setItem(`lk-token-${slug}`, data.token);
      sessionStorage.setItem(`lk-apptoken-${slug}`, data.appToken);
      sessionStorage.setItem(`lk-name-${slug}`, name.trim());
      sessionStorage.setItem(`lk-identity-${slug}`, data.identity);

      const link = `${window.location.origin}/meeting/${slug}`;
      setShareLink(link);
      setRoomSlug(slug);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function copyLink() {
    if (!shareLink) return;
    await navigator.clipboard.writeText(shareLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function joinNow() {
    if (roomSlug) router.push(`/meeting/${roomSlug}`);
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-900 p-4">
      <div className="w-full max-w-md space-y-4">

        {/* Card */}
        <div className="bg-slate-800 rounded-2xl shadow-2xl p-8 border border-slate-700">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center">
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">New Meeting</h1>
              <p className="text-slate-400 text-sm">Enter your name to get started</p>
            </div>
          </div>

          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">Your name</label>
              <input
                autoFocus
                className="w-full px-4 py-2.5 bg-slate-700 border border-slate-600 rounded-lg text-white
                           placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="e.g. Jack"
                value={name}
                onChange={e => setName(e.target.value)}
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading || !name.trim()}
              className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50
                         text-white font-semibold py-2.5 rounded-lg transition-colors
                         flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Creating…
                </>
              ) : "Create Meeting"}
            </button>
          </form>
        </div>

        {/* Share link card — shown after creation */}
        {shareLink && (
          <div className="bg-slate-800 rounded-2xl p-6 border border-emerald-700/50 shadow-2xl space-y-4">
            <p className="text-sm font-medium text-emerald-400">Meeting ready — share this link</p>

            <div className="flex items-center gap-2 bg-slate-700 rounded-lg px-3 py-2">
              <span className="text-slate-300 text-sm font-mono truncate flex-1">{shareLink}</span>
              <button
                onClick={copyLink}
                className="shrink-0 text-xs bg-slate-600 hover:bg-slate-500 text-white
                           px-3 py-1.5 rounded-md transition-colors"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>

            <button
              onClick={joinNow}
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold
                         py-2.5 rounded-lg transition-colors"
            >
              Join Now →
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
