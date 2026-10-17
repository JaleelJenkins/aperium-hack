import { NextResponse, type NextRequest } from "next/server";
import { audit, getDb } from "@/lib/db";
import { gmailApi, oauthClient, saveAccount } from "@/lib/gmail/client";

export const runtime = "nodejs";

/** Gmail OAuth callback: exchange the code and store the inbox's refresh token. */
export async function GET(req: NextRequest) {
  const home = new URL("/", req.url);
  const fail = (msg: string) => {
    home.searchParams.set("error", msg);
    const res = NextResponse.redirect(home);
    res.cookies.delete("gmail_oauth_state");
    return res;
  };

  const params = req.nextUrl.searchParams;
  if (params.get("error")) return fail(`Google returned: ${params.get("error")}`);
  const code = params.get("code");
  const state = params.get("state");
  if (!code) return fail("Missing authorization code");
  if (!state || state !== req.cookies.get("gmail_oauth_state")?.value) return fail("OAuth state mismatch; try again");

  try {
    const client = oauthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) return fail("Google did not return a refresh token; remove the app's access and reconnect");
    client.setCredentials(tokens);
    const { emailAddress } = await gmailApi(client).getProfile();

    const db = getDb();
    saveAccount(db, emailAddress, {
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
      expiry_date: tokens.expiry_date,
      scope: tokens.scope,
    });
    audit(db, "user", "gmail.connected", `gmail_account:${emailAddress}`, { scope: tokens.scope });

    home.searchParams.set("connected", emailAddress);
    const res = NextResponse.redirect(home);
    res.cookies.delete("gmail_oauth_state");
    return res;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
