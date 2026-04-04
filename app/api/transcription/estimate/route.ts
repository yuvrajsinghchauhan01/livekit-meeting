import { NextRequest, NextResponse } from "next/server";
import { verifyAppToken } from "@/lib/auth";
import { estimateRoomTranscriptionCost } from "@/lib/transcription";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const headerToken = req.headers.get("Authorization")?.replace("Bearer ", "");
  const bodyToken = typeof body.appToken === "string" ? body.appToken : undefined;
  const rawToken = headerToken || bodyToken;

  if (!rawToken || !(await verifyAppToken(rawToken))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const roomName = typeof body.roomName === "string" ? body.roomName.trim() : "";
  const prefix = typeof body.prefix === "string" && body.prefix.trim() ? body.prefix.trim() : undefined;

  if (!roomName) {
    return NextResponse.json({ error: "roomName required" }, { status: 400 });
  }

  try {
    const estimate = await estimateRoomTranscriptionCost(roomName, prefix);
    return NextResponse.json(estimate);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
