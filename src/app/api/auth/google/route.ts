import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { GMAIL_SCOPES, oauthClient } from "@/lib/gmail/client";

export const runtime = "nodejs";

/** Start Gmail OAuth: redirect to Google's consent screen. */
export async function GET(req: NextRequest) {
  let client;
  try {
    client = oauthClient();
  } catch (err) {
    const home = new URL("/", req.url);
    home.searchParams.set("error", err instanceof Error ? err.message : String(err));
    return NextResponse.redirect(home);
  }
  const state = crypto.randomBytes(16).toString("hex");
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // always return a refresh token, even on reconnect
    scope: GMAIL_SCOPES,
    include_granted_scopes: true,
    state,
  });
  const res = NextResponse.redirect(url);
  res.cookies.set("gmail_oauth_state", state, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600 });
  return res;
}
