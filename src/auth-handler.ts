/**
 * Default (non-API) handler for the OAuthProvider.
 *
 * Best-practice MCP auth: this server is the OAuth Authorization Server for MCP
 * clients (handled by @cloudflare/workers-oauth-provider), but it does NOT do
 * GitHub OAuth itself. It DELEGATES user sign-in to the platform auth worker
 * (auth.freegamestore.online), which already owns the one configured GitHub
 * app. So the MCP needs no GitHub app of its own and nothing to register.
 *
 * Flow:
 *   /authorize  → parse the MCP client's request, stash it, bounce to the auth
 *                 worker's /login?redirect=<our /callback>
 *   auth worker → GitHub → sets the fgs_token cookie on .freegamestore.online,
 *                 redirects back to our /callback (a subdomain, so it gets the
 *                 cookie)
 *   /callback   → read fgs_token, completeAuthorization() with it as the props
 *                 token, redirect the client back with its code
 */
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

interface Env {
  OAUTH_PROVIDER: OAuthHelpers;
  OAUTH_KV: KVNamespace;
  AUTH_BASE: string; // e.g. https://auth.freegamestore.online
  AUTH: Fetcher; // service binding to the auth worker (verify fgs_token via /me)
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  const m = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/** fgs_token is a JWT; its `login` claim is the GitHub username (sub is github:<id>). */
function decodeLogin(jwt: string): string | undefined {
  try {
    const p = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(p + "===".slice(0, (4 - (p.length % 4)) % 4))) as {
      login?: string;
      sub?: string;
    };
    return payload.login || payload.sub;
  } catch {
    return undefined;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Step 1 — MCP client lands here. Stash its OAuth request, bounce to auth worker.
    if (url.pathname === "/authorize") {
      let oauthReqInfo;
      try {
        oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      } catch {
        // Unknown/stale client (e.g. registered against an older server) — fail
        // gracefully so mcp-remote re-registers instead of seeing a 500.
        return new Response("invalid_client: please reconnect to re-register", { status: 400 });
      }
      if (!oauthReqInfo.clientId) return new Response("invalid_request", { status: 400 });

      const reqId = crypto.randomUUID();
      await env.OAUTH_KV.put(`mcpauthreq:${reqId}`, JSON.stringify(oauthReqInfo), { expirationTtl: 600 });

      const callback = new URL("/callback", url.origin);
      callback.searchParams.set("reqId", reqId);

      const login = new URL("/login", env.AUTH_BASE);
      login.searchParams.set("redirect", callback.toString());
      return Response.redirect(login.toString(), 302);
    }

    // Step 2 — back from the auth worker with the fgs_token cookie set.
    if (url.pathname === "/callback") {
      const reqId = url.searchParams.get("reqId");
      const raw = reqId ? await env.OAUTH_KV.get(`mcpauthreq:${reqId}`) : null;
      if (!raw) return new Response("invalid or expired authorization request", { status: 400 });
      await env.OAUTH_KV.delete(`mcpauthreq:${reqId}`);

      const fgsToken = getCookie(request, "fgs_token");
      if (!fgsToken) return new Response("sign-in did not complete (no session cookie)", { status: 401 });

      // SECURITY: verify the token's signature via the auth worker BEFORE trusting
      // any claim from it. decodeLogin() is an unsigned read — without this, a forged
      // fgs_token cookie could set props.userId/login to any GitHub user and bypass
      // the ownership gate. Service binding avoids the same-zone loopback (CF 522).
      const verify = await env.AUTH.fetch("https://auth.freegamestore.online/me", { headers: { "X-FGS-Token": fgsToken } });
      if (!verify.ok) return new Response("invalid or expired session token", { status: 401 });
      const login = decodeLogin(fgsToken);

      const oauthReqInfo = JSON.parse(raw);
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReqInfo,
        userId: login ?? "user",
        scope: oauthReqInfo.scope ?? [],
        metadata: { label: login ?? "FreeGameStore user" },
        // props reach the MCP tools as this.props
        props: { token: fgsToken, userId: login },
      });
      return Response.redirect(redirectTo, 302);
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "FreeGameStore MCP\nConnect: npx mcp-remote https://mcp.freegamestore.online/mcp\nSign-in is delegated to auth.freegamestore.online.\n",
        { headers: { "content-type": "text/plain" } },
      );
    }

    return new Response("Not found", { status: 404 });
  },
};
