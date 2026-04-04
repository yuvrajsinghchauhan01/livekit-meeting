import { NextRequest, NextResponse } from "next/server";
import { verifyAppToken } from "@/lib/auth";
import { EgressClient } from "livekit-server-sdk";
import { DirectFileOutput, S3Upload } from "@livekit/protocol";

export async function POST(req: NextRequest) {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await verifyAppToken(auth.slice(7)))) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const { roomName, participantIdentity, trackSid } = await req.json();
  if (!roomName || !participantIdentity || !trackSid) {
    return NextResponse.json(
      { error: "roomName, participantIdentity, and trackSid required" },
      { status: 400 }
    );
  }

  const egressClient = new EgressClient(
    process.env.LIVEKIT_URL!,
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!
  );

  // Dedup: if an egress is already active for this participant in this room, return it
  try {
    const existing = await egressClient.listEgress({ roomName, active: true });
    const match = existing.find(
      (e) =>
        Boolean((e as { trackEgress?: unknown }).trackEgress) &&
        "participantIdentity" in e &&
        (e as { participantIdentity?: string }).participantIdentity === participantIdentity
    );
    if (match) {
      return NextResponse.json({
        egressId:  match.egressId,
        trackSid,
        s3Path:    `s3://${process.env.S3_BUCKET}/recordings/${roomName}/${participantIdentity}/TR_${trackSid}.ogg`,
        startedAt: Number(match.startedAt) || Date.now(),
        deduplicated: true,
      });
    }
  } catch {
    // listEgress failure is non-fatal — proceed to start
  }

  // S3 path: recordings/<roomName>/<participant>/TR_<trackSid>.ogg
  const s3Key = `recordings/${roomName}/${participantIdentity}/TR_${trackSid}.ogg`;

  // DirectFileOutput: filepath = S3 key, output.case = "s3" with credentials
  const directFileOutput = new DirectFileOutput({
    filepath: s3Key,
    output: {
      case: "s3",
      value: new S3Upload({
        accessKey: process.env.AWS_ACCESS_KEY_ID!,
        secret:    process.env.AWS_SECRET_ACCESS_KEY!,
        region:    process.env.AWS_REGION!,
        bucket:    process.env.S3_BUCKET!,
      }),
    },
  });

  try {
    // TrackEgress records a single track — audio only, OGG format
    const egressInfo = await egressClient.startTrackEgress(
      roomName,
      directFileOutput,
      trackSid
    );

    const startedAt = Date.now();

    return NextResponse.json({
      egressId:  egressInfo.egressId,
      trackSid,
      s3Path:    `s3://${process.env.S3_BUCKET}/${s3Key}`,
      startedAt,
    });
  } catch (err: unknown) {
    console.error("Egress start error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
