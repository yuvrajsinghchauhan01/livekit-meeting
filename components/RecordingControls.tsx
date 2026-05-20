"use client";

import { useEffect, useRef, useState } from "react";
import { useLocalParticipant } from "@livekit/components-react";
import { Track, TrackPublication } from "livekit-client";

interface Props {
  roomName:            string;
  participantIdentity: string;
  displayName:         string;
  appToken:            string;
  onStopRef:           React.MutableRefObject<() => void>;
}

export default function RecordingControls({
  roomName,
  participantIdentity,
  displayName,
  appToken,
  onStopRef,
}: Props) {
  const { localParticipant } = useLocalParticipant();
  const [recording, setRecording] = useState(false);
  const [error, setError]         = useState<string | null>(null);

  const egressId  = useRef<string | null>(null);
  const trackSid  = useRef<string | null>(null);
  const startedAt = useRef<number | null>(null);
  const started   = useRef(false);

  async function startRecording(sid: string) {
    if (started.current || egressId.current) return;
    started.current = true;

    try {
      const res = await fetch("/api/egress/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${appToken}` },
        body: JSON.stringify({ roomName, participantIdentity, trackSid: sid }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start recording");

      egressId.current  = data.egressId;
      trackSid.current  = sid;
      startedAt.current = data.startedAt;
      setRecording(true);
    } catch (err: unknown) {
      started.current = false;
      setError(err instanceof Error ? err.message : "Recording failed to start");
    }
  }

  function stopRecording() {
    if (!egressId.current) return Promise.resolve();

    const payload = JSON.stringify({
      egressId:            egressId.current,
      roomName,
      participantIdentity,
      displayName,
      trackSid:            trackSid.current,
      startedAt:           startedAt.current,
      appToken,
    });

    egressId.current = null;
    started.current  = false;
    setRecording(false);

    // keepalive: true survives page unload AND can be awaited — unlike sendBeacon
    return fetch("/api/egress/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(console.error);
  }

  // Expose stopRecording to parent via ref so it can call it on leave
  useEffect(() => {
    onStopRef.current = stopRecording;
  });

  useEffect(() => {
    if (!localParticipant) return;

    const existing = localParticipant.getTrackPublication(Track.Source.Microphone);
    if (existing?.trackSid) {
      startRecording(existing.trackSid);
      return;
    }

    function onPublished(pub: TrackPublication) {
      if (pub.source === Track.Source.Microphone && pub.trackSid) {
        startRecording(pub.trackSid);
      }
    }

    localParticipant.on("localTrackPublished", onPublished);
    return () => { localParticipant.off("localTrackPublished", onPublished); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localParticipant]);

  if (error) return <p className="text-xs text-red-400">⚠ {error}</p>;

  if (recording) {
    return (
      <div className="flex items-center gap-2 bg-red-900/40 border border-red-700/50
                      rounded-lg px-3 py-1.5 text-sm text-red-300">
        <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
        Recording
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-slate-500 text-xs">
      <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      Starting recording…
    </div>
  );
}
