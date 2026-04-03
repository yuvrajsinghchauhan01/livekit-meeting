import { NextRequest, NextResponse } from "next/server";
import { signAppToken } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();

  if (!username || !password) {
    return NextResponse.json({ error: "Username and password required" }, { status: 400 });
  }

  // Simple shared-password auth. 
  // For a real app, replace this with a DB lookup.
  const appPassword = process.env.APP_PASSWORD;
  if (password !== appPassword) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const token = await signAppToken(username.trim());
  return NextResponse.json({ token, username: username.trim() });
}
