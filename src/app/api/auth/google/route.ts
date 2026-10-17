import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { GMAIL_SCOPES, oauthClient } from "@/lib/gmail/client";

export const runtime = "nodejs";

/** Start Gmail OAuth: redirect to Google's consent screen. */
export async function GET() {
  const state = crypto.randomBytes(16).toString("hex");
  const url = oauthClient().generateAuthUrl({
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
