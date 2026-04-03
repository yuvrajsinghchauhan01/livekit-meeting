import { NextRequest, NextResponse } from "next/server";
import { verifyAppToken } from "@/lib/auth";
import { EgressClient } from "livekit-server-sdk";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

export async function POST(req: NextRequest) {
  // Auth — sendBeacon can't set headers, so accept token from body too
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const headerToken = req.headers.get("Authorization")?.replace("Bearer ", "");
  const bodyToken   = typeof body.appToken === "string" ? body.appToken : undefined;
  const rawToken    = headerToken || bodyToken;

  if (!rawToken || !(await verifyAppToken(rawToken))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { egressId, roomName, participantIdentity, trackSid, startedAt } = body as Record<string, string | number>;
  if (!egressId) {
    return NextResponse.json({ error: "egressId required" }, { status: 400 });
  }

  const egressClient = new EgressClient(
    process.env.LIVEKIT_URL!,
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!
  );

  try {
    const egressInfo = await egressClient.stopEgress(egressId);
    const stoppedAt = Date.now();

    // Write metadata JSON alongside the OGG file if we have full context
    if (roomName && participantIdentity && trackSid) {
      const metadata = {
        roomName,
        participantIdentity,
        trackSid,
        audioFile: `TR_${trackSid}.ogg`,
        startedAt:   startedAt ?? null,
        stoppedAt,
        durationMs:  startedAt ? stoppedAt - startedAt : null,
        // ISO strings for human readability
        startedAtISO:  startedAt ? new Date(startedAt).toISOString() : null,
        stoppedAtISO:  new Date(stoppedAt).toISOString(),
      };

      const s3 = new S3Client({
        region: process.env.AWS_REGION!,
        credentials: {
          accessKeyId:     process.env.AWS_ACCESS_KEY_ID!,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        },
      });

      const metaKey = `recordings/${roomName}/${participantIdentity}/EG_${trackSid}.json`;
      await s3.send(new PutObjectCommand({
        Bucket:      process.env.S3_BUCKET!,
        Key:         metaKey,
        Body:        JSON.stringify(metadata, null, 2),
        ContentType: "application/json",
      }));
    }

    return NextResponse.json({ status: egressInfo.status, egressId, stoppedAt });
  } catch (err: unknown) {
    console.error("Egress stop error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
