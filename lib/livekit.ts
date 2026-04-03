import { AccessToken } from "livekit-server-sdk";
import { createHash } from "crypto";

/**
 * Stable identity: sha256(username:roomName) truncated to 16 hex chars.
 * This never changes even if the user picks a different display name.
 */
export function stableIdentity(username: string, roomName: string): string {
  return createHash("sha256")
    .update(`${username}:${roomName}`)
    .digest("hex")
    .slice(0, 16);
}

export async function createLiveKitToken(
  roomName: string,
  participantName: string
): Promise<string> {
  const apiKey = process.env.LIVEKIT_API_KEY!;
  const apiSecret = process.env.LIVEKIT_API_SECRET!;

  const identity = stableIdentity(participantName, roomName);

  const at = new AccessToken(apiKey, apiSecret, {
    identity,          // stable — used for S3 path and egress dedup
    name: participantName, // display name — can change freely
    ttl: "24h",
  });

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  return at.toJwt();
}
