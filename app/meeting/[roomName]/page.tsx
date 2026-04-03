"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import MeetingRoom from "@/components/MeetingRoom";

export default function MeetingPage() {
  const params   = useParams();
  const router   = useRouter();
  const roomName = params.roomName as string;

  const [token, setToken]         = useState<string | null>(null);
  const [appToken, setAppToken]   = useState<string>("");
  const [displayName, setName]    = useState<string>("");
  const [identity, setIdentity]   = useState<string>("");

  // Guest join form state
  const [guestName, setGuestName] = useState("");
  const [joining, setJoining]     = useState(false);
  const [error, setError]         = useState("");

  useEffect(() => {
    // Host already has tokens from the create flow
    const lkToken  = sessionStorage.getItem(`lk-token-${roomName}`);
    const appJwt   = sessionStorage.getItem(`lk-apptoken-${roomName}`) || "";
    const name     = sessionStorage.getItem(`lk-name-${roomName}`) || "";
    const id       = sessionStorage.getItem(`lk-identity-${roomName}`) || "";

    if (lkToken && name) {
      setToken(lkToken);
      setAppToken(appJwt);
      setName(name);
      setIdentity(id);
    }
    // else: guest — show name entry form
  }, [roomName]);

  async function handleGuestJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!guestName.trim()) return;
    setError("");
    setJoining(true);

    try {
      const res = await fetch("/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName, participantName: guestName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to join");

      sessionStorage.setItem(`lk-token-${roomName}`, data.token);
      sessionStorage.setItem(`lk-apptoken-${roomName}`, data.appToken);
      sessionStorage.setItem(`lk-name-${roomName}`, guestName.trim());
      sessionStorage.setItem(`lk-identity-${roomName}`, data.identity);

      setToken(data.token);
      setAppToken(data.appToken);
      setName(guestName.trim());
      setIdentity(data.identity);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to join");
    } finally {
      setJoining(false);
    }
  }

  function handleLeave() {
    sessionStorage.removeItem(`lk-token-${roomName}`);
    sessionStorage.removeItem(`lk-apptoken-${roomName}`);
    sessionStorage.removeItem(`lk-name-${roomName}`);
    sessionStorage.removeItem(`lk-identity-${roomName}`);
    router.replace("/");
  }

  // Already have a token — go straight into the room
  if (token && displayName) {
    return (
      <MeetingRoom
        roomName={roomName}
        token={token}
        appToken={appToken}
        displayName={displayName}
        identity={identity}
        onLeave={handleLeave}
      />
    );
  }

  // Guest join screen
  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-900 p-4">
      <div className="w-full max-w-sm bg-slate-800 rounded-2xl shadow-2xl p-8 border border-slate-700">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center">
            <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Join Meeting</h1>
            <p className="text-slate-400 text-xs font-mono">{roomName}</p>
          </div>
        </div>

        <form onSubmit={handleGuestJoin} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">Your name</label>
            <input
              autoFocus
              className="w-full px-4 py-2.5 bg-slate-700 border border-slate-600 rounded-lg text-white
                         placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="e.g. Mac"
              value={guestName}
              onChange={e => setGuestName(e.target.value)}
              required
            />
          </div>

          {error && <p className="text-red-400 text-sm bg-red-400/10 px-3 py-2 rounded-lg">{error}</p>}

          <button
            type="submit"
            disabled={joining || !guestName.trim()}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50
                       text-white font-semibold py-2.5 rounded-lg transition-colors
                       flex items-center justify-center gap-2"
          >
            {joining ? (
              <>
                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Joining…
              </>
            ) : "Join Meeting →"}
          </button>
        </form>
      </div>
    </main>
  );
}
