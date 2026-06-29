/**
 * OAuth 2.1 provider for the FGS MCP server.
 * Self-contained GitHub OAuth: redirects to GitHub directly, then exchanges
 * the GitHub token for an FGS admin session via admin.freegamestore.online.
 * Vendored from fas/mcp — adapted to use FGS admin auth exchange.
 */

export interface OAuthConfig {
  /** Base URL of this MCP server (e.g. "https://mcp.freegamestore.online") */
  issuer: string;
  /** FGS admin base (e.g. "https://admin.freegamestore.online") */
  adminBase: string;
  /** Workers KV namespace for OAuth state */
  kv: KVNamespace;
  /** GitHub OAuth app client ID */
  githubClientId: string;
  /** GitHub OAuth app client secret */
  githubClientSecret: string;
}

/** Try to handle an OAuth-related request. Returns null if not an OAuth path. */
export async function handleOAuthRoute(
  request: Request,
  config: OAuthConfig,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS preflight for OAuth endpoints
  if (request.method === "OPTIONS") {
    if (
      path.startsWith("/.well-known/") ||
      path === "/register" ||
      path === "/authorize" ||
      path === "/oauth/callback" ||
      path === "/token"
    ) {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }
  }

  if (
    path === "/.well-known/oauth-protected-resource" ||
    path === "/.well-known/oauth-protected-resource/mcp"
  ) {
    return json({
      resource: `${config.issuer}/mcp`,
      authorization_servers: [config.issuer],
    });
  }
  if (path === "/.well-known/oauth-authorization-server") {
    return json({
      issuer: config.issuer,
      authorization_endpoint: `${config.issuer}/authorize`,
      token_endpoint: `${config.issuer}/token`,
      registration_endpoint: `${config.issuer}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  }
  if (path === "/register" && request.method === "POST") {
    return register(request, config);
  }
  if (path === "/authorize" && request.method === "GET") {
    return authorize(request, config);
  }
  if (path === "/oauth/callback" && request.method === "GET") {
    return oauthCallback(request, config);
  }
  if (path === "/token" && request.method === "POST") {
    return tokenExchange(request, config);
  }
  return null;
}

/**
 * Resolve a Bearer token that might be an OAuth access token.
 * Returns the underlying FGS admin session string, or null if not found in KV.
 */
export async function resolveOAuthToken(
  bearer: string,
  kv: KVNamespace,
): Promise<string | null> {
  return kv.get(`token:${bearer}`);
}

/**
 * 401 challenge for unauthenticated requests. The `WWW-Authenticate` header
 * points clients (mcp-remote) at the protected-resource metadata, which is what
 * triggers the OAuth browser sign-in flow. Without this, clients have no signal
 * to authenticate and just see a "not authenticated" tool error.
 */
export function unauthorizedChallenge(issuer: string): Response {
  const metadata = `${issuer}/.well-known/oauth-protected-resource/mcp`;
  return new Response(
    JSON.stringify({ error: "unauthorized", error_description: "Sign in required to use the FreeGameStore MCP." }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${metadata}"`,
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

// -- Internals --

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/** POST /register — dynamic client registration (required by mcp-remote) */
async function register(request: Request, config: OAuthConfig): Promise<Response> {
  // Rate limit: 20 registrations/hour/IP
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const hour = Math.floor(Date.now() / 3_600_000);
  const rlKey = `rl:reg:${ip}:${hour}`;
  const count = parseInt((await config.kv.get(rlKey)) ?? "0");
  if (count >= 20) {
    return json({ error: "rate_limit_exceeded" }, 429);
  }
  await config.kv.put(rlKey, String(count + 1), { expirationTtl: 3600 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return json({ error: "invalid_redirect_uri" }, 400);
  }

  const clientId = crypto.randomUUID();
  const client = {
    client_id: clientId,
    redirect_uris: redirectUris,
    client_name: body.client_name ?? null,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  await config.kv.put(`client:${clientId}`, JSON.stringify(client), {
    expirationTtl: 90 * 86_400, // 90 days
  });

  return json(client, 201);
}

/** GET /authorize — validate request, store auth state, redirect to GitHub OAuth */
async function authorize(request: Request, config: OAuthConfig): Promise<Response> {
  const url = new URL(request.url);
  const responseType = url.searchParams.get("response_type");
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const codeChallenge = url.searchParams.get("code_challenge");
  const codeChallengeMethod = url.searchParams.get("code_challenge_method");
  const state = url.searchParams.get("state");

  if (responseType !== "code") {
    return new Response("unsupported_response_type", { status: 400 });
  }
  if (!clientId || !redirectUri || !codeChallenge) {
    return new Response("missing client_id, redirect_uri, or code_challenge", { status: 400 });
  }
  if (codeChallengeMethod && codeChallengeMethod !== "S256") {
    return new Response("only S256 is supported", { status: 400 });
  }

  // Verify client registration
  const clientRaw = await config.kv.get(`client:${clientId}`);
  if (!clientRaw) {
    return new Response("invalid client_id", { status: 400 });
  }
  const client = JSON.parse(clientRaw) as { redirect_uris: string[] };
  if (!client.redirect_uris.includes(redirectUri)) {
    return new Response("redirect_uri not registered", { status: 400 });
  }

  // Store auth request (10-min TTL, single-use nonce)
  const nonce = crypto.randomUUID();
  await config.kv.put(
    `authreq:${nonce}`,
    JSON.stringify({ clientId, redirectUri, codeChallenge, state }),
    { expirationTtl: 600 },
  );

  // Redirect to GitHub OAuth directly (self-contained, no dependency on FGS auth worker).
  // Use `state` param to carry the nonce (standard OAuth practice).
  // Do NOT put nonce in the redirect_uri — GitHub requires exact match against registered callback.
  const callbackUrl = `${config.issuer}/oauth/callback`;

  const ghUrl = new URL("https://github.com/login/oauth/authorize");
  ghUrl.searchParams.set("client_id", config.githubClientId);
  ghUrl.searchParams.set("redirect_uri", callbackUrl);
  ghUrl.searchParams.set("scope", "read:user");
  ghUrl.searchParams.set("state", nonce);

  return Response.redirect(ghUrl.toString(), 302);
}

/** GET /oauth/callback — receives GitHub code, exchanges for GH token,
 *  then exchanges GH token for FGS admin session. */
async function oauthCallback(request: Request, config: OAuthConfig): Promise<Response> {
  const url = new URL(request.url);
  // GitHub echoes nonce back as `state` (standard OAuth)
  const nonce = url.searchParams.get("state");
  const ghCode = url.searchParams.get("code");

  if (!nonce || !ghCode) {
    return new Response("missing nonce/state or code", { status: 400 });
  }

  // Retrieve and consume auth request (single-use)
  const reqRaw = await config.kv.get(`authreq:${nonce}`);
  if (!reqRaw) {
    return new Response("invalid or expired nonce", { status: 400 });
  }
  await config.kv.delete(`authreq:${nonce}`);

  // Step 1: Exchange GitHub code for access token
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      code: ghCode,
    }),
  });
  if (!tokenRes.ok) {
    return new Response("GitHub token exchange failed", { status: 502 });
  }
  const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenData.access_token) {
    return new Response(`GitHub OAuth error: ${tokenData.error ?? "no access_token"}`, { status: 400 });
  }

  // Step 2: Exchange GitHub token for FGS admin session
  const exchangeRes = await fetch(`${config.adminBase}/v1/auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ githubToken: tokenData.access_token }),
  });
  if (!exchangeRes.ok) {
    return new Response(`FGS admin auth exchange failed (${exchangeRes.status})`, { status: 502 });
  }
  const exchangeData = (await exchangeRes.json()) as { sessionToken?: string; login?: string; error?: string };
  if (!exchangeData.sessionToken) {
    return new Response(`FGS admin auth error: ${exchangeData.error ?? "no sessionToken"}`, { status: 400 });
  }

  const authReq = JSON.parse(reqRaw) as {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state: string | null;
  };

  // Generate single-use auth code (10-min TTL)
  const code = crypto.randomUUID();
  await config.kv.put(
    `code:${code}`,
    JSON.stringify({
      fgsSession: exchangeData.sessionToken,
      login: exchangeData.login,
      codeChallenge: authReq.codeChallenge,
      redirectUri: authReq.redirectUri,
      clientId: authReq.clientId,
    }),
    { expirationTtl: 600 },
  );

  // Redirect to client's redirect_uri with auth code
  const redirect = new URL(authReq.redirectUri);
  redirect.searchParams.set("code", code);
  if (authReq.state) {
    redirect.searchParams.set("state", authReq.state);
  }
  return Response.redirect(redirect.toString(), 302);
}

/** POST /token — exchange auth code for access token (PKCE S256 verified) */
async function tokenExchange(request: Request, config: OAuthConfig): Promise<Response> {
  let body: URLSearchParams;
  try {
    body = new URLSearchParams(await request.text());
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  if (body.get("grant_type") !== "authorization_code") {
    return json({ error: "unsupported_grant_type" }, 400);
  }

  const code = body.get("code");
  const redirectUri = body.get("redirect_uri");
  const clientId = body.get("client_id");
  const codeVerifier = body.get("code_verifier");

  if (!code || !redirectUri || !clientId || !codeVerifier) {
    return json({ error: "invalid_request" }, 400);
  }

  // Retrieve and consume auth code (single-use)
  const codeRaw = await config.kv.get(`code:${code}`);
  if (!codeRaw) {
    return json({ error: "invalid_grant" }, 400);
  }
  await config.kv.delete(`code:${code}`);

  const codeData = JSON.parse(codeRaw) as {
    fgsSession: string;
    login?: string;
    codeChallenge: string;
    redirectUri: string;
    clientId: string;
  };

  if (codeData.redirectUri !== redirectUri || codeData.clientId !== clientId) {
    return json({ error: "invalid_grant" }, 400);
  }

  // Verify PKCE (S256): SHA-256(code_verifier) must equal code_challenge
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  const computed = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  if (computed !== codeData.codeChallenge) {
    return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
  }

  // Issue opaque access token -> maps to FGS admin session in KV (24h TTL)
  const accessToken = crypto.randomUUID();
  await config.kv.put(`token:${accessToken}`, codeData.fgsSession, {
    expirationTtl: 86_400,
  });

  return json({
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 86_400,
  });
}
