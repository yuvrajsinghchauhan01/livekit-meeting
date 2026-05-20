import { NextRequest, NextResponse } from "next/server";
import { verifyAppToken } from "@/lib/auth";
import { EgressClient } from "livekit-server-sdk";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getAppMetadataKey, queueRoomTranscription } from "@/lib/transcription";

// How long to wait before force-stopping stuck egress and triggering transcription
const STUCK_EGRESS_TIMEOUT_MS = Number(process.env.STUCK_EGRESS_TIMEOUT_MS || "30000");

// Track rooms where a fallback timer is already scheduled
const pendingFallbacks = new Set<string>();

/**
 * Called when active egress > 0 after a participant leaves.
 * Waits STUCK_EGRESS_TIMEOUT_MS, then force-stops any remaining active egress
 * and triggers transcription — handles browsers that crash without calling stop.
 */
function scheduleStuckEgressFallback(roomName: string, egressClient: EgressClient) {
  if (pendingFallbacks.has(roomName)) {
    console.log(`[egress:fallback] timer already pending room=${roomName}`);
    return;
  }

  pendingFallbacks.add(roomName);
  console.log(
    `[egress:fallback] scheduling stuck-egress check room=${roomName} delay=${STUCK_EGRESS_TIMEOUT_MS}ms`
  );

  setTimeout(async () => {
    pendingFallbacks.delete(roomName);
    try {
      const activeEgress = await egressClient.listEgress({ roomName, active: true });
      console.log(
        `[egress:fallback] check room=${roomName} active=${activeEgress.length}`
      );

      if (activeEgress.length === 0) {
        console.log(`[egress:fallback] no stuck egress found room=${roomName}`);
        return;
      }

      // Force-stop all remaining stuck egress
      console.log(
        `[egress:fallback] force-stopping ${activeEgress.length} stuck egress room=${roomName}`
      );
      await Promise.allSettled(
        activeEgress.map((eg) =>
          egressClient.stopEgress(eg.egressId).catch((err) => {
            console.error(
              `[egress:fallback] failed to stop egress=${eg.egressId} room=${roomName}:`,
              err
            );
          })
        )
      );

      // Trigger transcription now that all egress are stopped
      console.log(
        `[egress:fallback] queueing transcription after force-stop room=${roomName}`
      );
      void queueRoomTranscription({ roomName, trigger: "automatic" }).catch((err) => {
        console.error(`[egress:fallback] transcription queue failed room=${roomName}:`, err);
      });
    } catch (err) {
      console.error(`[egress:fallback] error room=${roomName}:`, err);
    }
  }, STUCK_EGRESS_TIMEOUT_MS);
}

export async function POST(req: NextRequest) {
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

  const egressId            = typeof body.egressId === "string" ? body.egressId : "";
  const roomName            = typeof body.roomName === "string" ? body.roomName : "";
  const participantIdentity = typeof body.participantIdentity === "string" ? body.participantIdentity : "";
  const displayName         = typeof body.displayName === "string" ? body.displayName : "";
  const trackSid            = typeof body.trackSid === "string" ? body.trackSid : "";
  const startedAt           = typeof body.startedAt === "number" ? body.startedAt : null;

  if (!egressId) {
    return NextResponse.json({ error: "egressId required" }, { status: 400 });
  }

  const egressClient = new EgressClient(
    process.env.LIVEKIT_URL!,
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!
  );

  try {
    let egressInfo;
    try {
      egressInfo = await egressClient.stopEgress(egressId);
    } catch (stopErr: unknown) {
      // Egress already completed on its own (e.g. participant disconnected) — treat as success
      const isAlreadyDone =
        stopErr instanceof Error &&
        (stopErr.message.includes("EGRESS_COMPLETE") ||
          stopErr.message.includes("failed_precondition") ||
          (stopErr as { code?: string }).code === "failed_precondition");

      if (!isAlreadyDone) throw stopErr;

      console.log(
        `[egress:stop] egress=${egressId} already completed, treating as clean stop room=${roomName || "unknown"}`
      );
      egressInfo = { status: 3 }; // EGRESS_COMPLETE = 3
    }

    const stoppedAt = Date.now();
    console.log(
      `[egress:stop] stopped egress=${egressId} room=${roomName || "unknown"} participant=${participantIdentity || "unknown"} track=${trackSid || "unknown"} status=${egressInfo.status}`
    );

    if (roomName && participantIdentity && trackSid) {
      const s3 = new S3Client({
        region: process.env.AWS_REGION!,
        credentials: {
          accessKeyId:     process.env.AWS_ACCESS_KEY_ID!,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        },
      });

      const metaKey    = `recordings/${roomName}/${participantIdentity}/EG_${trackSid}.json`;
      const appMetaKey = getAppMetadataKey(roomName, participantIdentity, trackSid);

      // Idempotency — skip writes if already written (double-stop from sendBeacon + leave)
      const alreadyWritten = await s3.send(new HeadObjectCommand({
        Bucket: process.env.S3_BUCKET!,
        Key: metaKey,
      })).then(() => true).catch(() => false);

      if (!alreadyWritten) {
        console.log(
          `[egress:stop] writing metadata room=${roomName} participant=${participantIdentity} track=${trackSid}`
        );
        await s3.send(new PutObjectCommand({
          Bucket:      process.env.S3_BUCKET!,
          Key:         metaKey,
          Body:        JSON.stringify({
            roomName,
            participantIdentity,
            trackSid,
            audioFile:    `TR_${trackSid}.ogg`,
            startedAt,
            stoppedAt,
            durationMs:   startedAt ? stoppedAt - startedAt : null,
            startedAtISO: startedAt ? new Date(startedAt).toISOString() : null,
            stoppedAtISO: new Date(stoppedAt).toISOString(),
          }, null, 2),
          ContentType: "application/json",
        }));

        // APP_*.json — includes displayName for transcription speaker mapping
        await s3.send(new PutObjectCommand({
          Bucket:      process.env.S3_BUCKET!,
          Key:         appMetaKey,
          Body:        JSON.stringify({
            roomName,
            participantIdentity,
            displayName: displayName.trim() || participantIdentity,
            trackSid,
            audioFileKey:      `recordings/${roomName}/${participantIdentity}/TR_${trackSid}.ogg`,
            egressMetadataKey: metaKey,
            startedAt,
            stoppedAt,
            recordedAt: new Date(stoppedAt).toISOString(),
          }, null, 2),
          ContentType: "application/json",
        }));
      } else {
        console.log(
          `[egress:stop] metadata already exists room=${roomName} participant=${participantIdentity} track=${trackSid}, skipping write`
        );
      }

      // Auto-trigger transcription when last participant stops recording
      try {
        const activeEgress = await egressClient.listEgress({ roomName, active: true });
        console.log(
          `[egress:stop] active egress check room=${roomName} active=${activeEgress.length}`
        );
        if (activeEgress.length === 0) {
          console.log(
            `[egress:stop] queueing automatic transcription room=${roomName}`
          );
          void queueRoomTranscription({ roomName, trigger: "automatic" }).catch((err) => {
            console.error(`Auto transcription queue failed for ${roomName}:`, err);
          });
        } else {
          console.log(
            `[egress:stop] not queueing transcription yet room=${roomName} active_egress_remaining=${activeEgress.length}`
          );
          // Schedule a fallback in case remaining egress are stuck (crashed browsers)
          scheduleStuckEgressFallback(roomName, egressClient);
        }
      } catch (err) {
        console.error(`Failed to check active egress for ${roomName}:`, err);
      }
    }

    return NextResponse.json({ status: egressInfo.status, egressId, stoppedAt });
  } catch (err: unknown) {
    console.error("Egress stop error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
