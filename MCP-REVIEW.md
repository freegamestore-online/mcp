# freegamestore-mcp — review & corrections (2026-06-04)

Review of this `fgs/mcp` build against the canonical FAS implementation
(`freeappstore-online/mcp`, which it was modeled on). **Verdict: faithful and
correct** — the tricky parts were handled. This file lists the few follow-ups
to finish, and what NOT to change.

## ✅ Verified good (don't undo these)
- **Auth DO-inject:** `setAuth(props)` + the fetch-handler injection keyed
  `streamable-http:${mcp-session-id}` is the right fix for `agents@0.0.74`'s
  Streamable HTTP `serve()` dropping `ctx.props`. Token is passed through (no
  local HMAC verify) — correct, because the worker doesn't hold the session
  signing key; the backend/admin is the auth authority.
- **`github.ts` template filter** uses `.startsWith(".git/")` (not `.git`), so
  `.github/workflows/deploy.yml` ships and games actually deploy. Leave it.
- **npm, not pnpm** (`package-lock.json`); `tsc --noEmit` is clean. Keep npm —
  `@modelcontextprotocol/sdk` + `zod` only resolve transitively (via `agents`)
  under npm's flat `node_modules`.
- **FGS-correct provisioning:** `create_game` → `POST /api/provision` on the
  admin worker (FGS has no `/v1/publish`). Verified the FGS admin returns **401
  (Bearer-gated), not a CF-Access 302**, so this direct external call works.
- **FGS-correct ownership:** uses the registry's per-game `creatorGithub` (FGS
  has no `/v1/apps/mine`); `create_game` writes it, `update_files`/`ownsGame`
  gate on it.

## Resolution status (2026-06-04, post-build)

The server is built, deployed (`mcp.freegamestore.online`, CI), and smoke-tested.
- ✅ **#1 GITHUB_TOKEN** — set on the worker in CI (`wrangler secret put` from repo
  secret `GH_ORG_TOKEN` = Doppler `GH_ADMIN_TOKEN`). Proven by `create_game` +
  `update_files` succeeding (both push to GitHub incl. `deploy.yml`).
- ✅ **#2 CF Access comment** — added at the `adminPost(.../api/provision)` call in
  `src/index.ts`.
- 🟡 **#3 smoke test** — `initialize` → `tools/list` (12) → `create_game` (deployed) →
  `update_files` (owner gate verified both ways) all pass. **`agent_build` still
  unverified** — needs a funded BYO AI key (FGS agent is bring-your-own-key, no vault).
  Cleanup caveat: the admin has **no deprovision endpoint** (routes are auth/status/
  quality/provision only), and `GH_ADMIN_TOKEN` lacks `delete_repo`, so the test game
  `mcp-smoke-test` was **archived + de-registered** (storefront-clean) but its D1 route +
  R2 content remain. A deprovision endpoint would be a worthwhile admin follow-up.
- ✅ **#4 docs parity** — `.well-known/mcp.json` (was stale → FGS + 12 tools), `llms.txt`,
  `SKILLS.md` (`## MCP Server`), `/docs/mcp` (Starlight), `ai/claude-code.html`,
  `build-with-ai.html` callout. (FGS uses `ai/claude-code.html`, not `claude-code.md`.)

## ⚠️ Corrections / follow-ups (original)

1. **`GITHUB_TOKEN` secret must be set on the worker.** The write tools
   (`create_game` scaffold push, `update_files`, pushing `deploy.yml`) need an
   org token with **both `contents:write` and `workflow`** scope. Set it from
   Doppler (project `fgs`, config `prd`):
   ```
   doppler secrets get GH_ADMIN_TOKEN --project fgs --config prd --plain \
     | npx wrangler secret put GITHUB_TOKEN
   ```
   Without `workflow` scope the deploy.yml push is rejected → games 404.

2. **CF Access future-proofing (code comment, not a change yet).** `create_game`
   calls `admin.freegamestore.online/api/provision` *directly* with the user's
   Bearer — this works only because FGS admin is currently Bearer-gated. If FGS
   later puts admin behind **CF Access** (pending optional item, see
   stores-workspace issue #9 lineage), that external call will **302 at the edge
   before the worker runs**, and `create_game` will break. At that point switch
   to the FAS pattern: call a *public backend* endpoint that service-binds to
   admin (CF Access only applies at the public edge, not to service bindings).
   Add a comment near the `adminPost(.../api/provision)` call noting this.

3. **Smoke-test the full loop before announcing.** With the secret set:
   `initialize` → `tools/list` (12 tools) → `create_game` (throwaway id) →
   verify it deploys + serves at `<id>.freegamestore.online` → `update_files`
   to change a file → then `agent_build("make a <game> and deploy it")`
   (needs a **funded AI key in the user's vault** for the chosen provider).
   Clean up test games after (note: repo deletion needs a `delete_repo`-scoped
   token, which `GH_ADMIN_TOKEN` lacks — use the admin deprovision path).

4. **Docs parity.** Mirror what FAS shipped: update FGS's `SKILLS.md`
   (`## MCP Server`), `llms.txt`, `.well-known/mcp.json` (full 12-tool list),
   the `docs/mcp` page, `claude-code.md`, and add discoverability callouts on
   get-started / build-with-ai / docs. Lead with the two build models and the
   connect line:
   `claude mcp add freegamestore -- npx mcp-remote https://mcp.freegamestore.online/mcp`

## Reference
FAS canonical impl: `~/dev/stores/fas/mcp/src/{index.ts,github.ts}` and its
`docs/mcp.html` / `SKILLS.md` MCP section. Two live FAS demos:
`mcp-live-demo.freeappstore.online` (client-authored) and
`dice-roller-mcp.freeappstore.online` (agent-authored).
