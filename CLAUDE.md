# FreeGameStore MCP Server

Remote MCP server for AI agents (Cursor/Claude/etc.) to build, publish, and
improve games on FreeGameStore — straight from the editor.

- Endpoint: `mcp.freegamestore.online/mcp`
- Dev: `npm install && npm run dev`
- Deploy: `git push origin main` (auto-deploys via GitHub Actions)
- Connect: `claude mcp add freegamestore -- npx mcp-remote https://mcp.freegamestore.online/mcp`

## Two ways to build (both from your editor)

1. **Your model writes the code, the MCP ships it** — `create_game` → `read_file`/`update_files` to improve → `deploy_status`.
2. **The platform's VibeCode agent writes + deploys it, you just prompt** — `agent_build('make a X game and deploy it')` → `agent_status`.

## Tools

**Build (the CALLING model authors; auth + ownership):**

| Tool | Auth | Description |
|------|------|-------------|
| `create_game` | FGS token | Provision repo+R2 hosting+listing, scaffold a template (canvas/grid/cards/3d), push → live at `<id>.freegamestore.online`. The `fgs init`+`publish`+push loop, server-side. |
| `update_files` | owner | Write/overwrite files in your game's repo → auto-deploys in ~30-60s. |
| `read_file` / `list_files` | None | Read / list files in a game's repo. |

**Agent (the platform's VibeCode agent authors; you just prompt):**

| Tool | Auth | Description |
|------|------|-------------|
| `agent_build` | FGS token + BYO `api_key` | Prompt `agent.freegamestore.online`; it writes the code AND deploys. FGS's agent is **bring-your-own-key** (no vault yet) — pass `api_key` for provider anthropic/openai/google/github. Returns a `session_id`. |
| `agent_status` | FGS token | Poll an `agent_build` session — game id, deploy phase, live URL. |

**Info / inspect:**

| Tool | Auth | Description |
|------|------|-------------|
| `list_games` | FGS token | List games you published (by `creatorGithub`). |
| `deploy_status` | None | GitHub Actions deploy status (last 5 runs). |
| `game_info` | None | Live URL, repo, listing, up/down. |
| `game_logs` | None | Latest deploy/build logs (no runtime log backend on free tier). |
| `platform_guide` | None | Fetch SKILLS.md (full platform guide). |
| `sdk_reference` | None | `@freegamestore/games` reference (shell, topbar, auth, sounds, leaderboard, ui). |

## How it differs from FreeAppStore's MCP (vendored from, not imported)

- **Provision** hits the admin worker `POST /api/provision` (FGS has no `/v1/publish`),
  passing `creatorGithub` so the registry records ownership.
- **Ownership gate** reads `registry.json` on `freegamestore-online/freegamestore`
  (`creatorGithub === <login>`) — FGS has no `/v1/apps/mine`.
- **Agent** is public + bring-your-own-key (`aiConfig.apiKey` required; providers
  anthropic/openai/google/github) — no key vault yet.

## Secrets (Worker)

- `GITHUB_TOKEN` — org token with **contents:write + workflow** scope (from Doppler
  `GH_ADMIN_TOKEN`, `--project fgs --config prd`). Required for the write tools.
- CI deploy uses repo secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.

## Gotchas baked in (don't undo these)

- `agents@0.0.74` Streamable HTTP `serve()` drops `ctx.props` → the fetch handler
  RPC-calls `setAuth` on the DO keyed `streamable-http:<mcp-session-id>` before dispatch.
- Don't locally verify the session token (no signing key) — pass the Bearer through,
  decode `sub` best-effort for the ownership gate.
- Template fetch excludes `.git/` (trailing slash) NOT `.git` — else `.github/workflows`
  is dropped and the game 404s.
- npm, not pnpm — `@modelcontextprotocol/sdk` + `zod` resolve transitively via `agents`
  and only npm's flat `node_modules` lets `tsc` find them. Keep `package-lock.json`.
