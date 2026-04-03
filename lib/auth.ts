import { SignJWT, jwtVerify } from "jose";

const secret = new TextEncoder().encode(
  process.env.JWT_SECRET || "fallback-secret-change-me"
);

export interface AppTokenPayload {
  username: string;
  iat?: number;
  exp?: number;
}

/** Sign a short-lived app JWT (24 h) */
export async function signAppToken(username: string): Promise<string> {
  return new SignJWT({ username })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(secret);
}

/** Verify the app JWT and return the payload, or null if invalid */
export async function verifyAppToken(
  token: string
): Promise<AppTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload as AppTokenPayload;
  } catch {
    return null;
  }
}
