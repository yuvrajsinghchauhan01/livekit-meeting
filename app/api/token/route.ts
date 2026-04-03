import { NextRequest, NextResponse } from "next/server";
import { signAppToken } from "@/lib/auth";
import { createLiveKitToken, stableIdentity } from "@/lib/livekit";

export async function POST(req: NextRequest) {
  const { roomName, participantName } = await req.json();
  if (!roomName || !participantName) {
    return NextResponse.json({ error: "roomName and participantName required" }, { status: 400 });
  }

  const identity = stableIdentity(participantName, roomName);

  const [lkToken, appToken] = await Promise.all([
    createLiveKitToken(roomName, participantName),
    signAppToken(identity), // sign app JWT against stable identity, not display name
  ]);

  return NextResponse.json({ token: lkToken, appToken, identity });
}
