"use client";

import { useRef } from "react";
import {
  LiveKitRoom,
  VideoConference,
  RoomAudioRenderer,
  useParticipants,
} from "@livekit/components-react";
import RecordingControls from "./RecordingControls";

interface Props {
  roomName:    string;
  token:       string;
  appToken:    string;
  displayName: string;
  identity:    string;
  onLeave:     () => void;
}

function RoomInner({ roomName, identity, appToken, onLeave }: {
  roomName: string; identity: string; appToken: string; onLeave: () => void;
}) {
  const participants = useParticipants();
  const stopRecordingRef = useRef<() => void>(() => {});

  function handleLeave() {
    stopRecordingRef.current(); // stop egress before leaving
    onLeave();
  }

  return (
    <div className="flex flex-col h-screen bg-slate-900">
      <header className="flex items-center justify-between px-4 py-3
                         bg-slate-800 border-b border-slate-700 shrink-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.894L15
                   14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
            </svg>
          </div>
          <div>
            <h1 className="font-semibold text-white text-sm">{roomName}</h1>
            <p className="text-slate-400 text-xs">
              {participants.length} participant{participants.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap justify-end">
          <RecordingControls
            roomName={roomName}
            participantIdentity={identity}
            appToken={appToken}
            onStopRef={stopRecordingRef}
          />
          <button
            onClick={handleLeave}
            className="flex items-center gap-2 bg-red-600 hover:bg-red-500 text-white
                       text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0
                   013-3h4a3 3 0 013 3v1" />
            </svg>
            Leave
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-hidden">
        <VideoConference />
      </div>

      <RoomAudioRenderer />
    </div>
  );
}

export default function MeetingRoom({ roomName, token, appToken, displayName, identity, onLeave }: Props) {
  return (
    <LiveKitRoom
      serverUrl={process.env.NEXT_PUBLIC_LIVEKIT_URL || "ws://localhost:7880"}
      token={token}
      connect={true}
      video={true}
      audio={true}
      className="h-screen"
    >
      <RoomInner
        roomName={roomName}
        identity={identity}
        appToken={appToken}
        onLeave={onLeave}
      />
    </LiveKitRoom>
  );
}
