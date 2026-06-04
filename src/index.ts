import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  fetchTemplateFiles,
  listRepoFiles,
  pushFiles,
  readRegistryGames,
  readRepoFile,
  type RepoFile,
  textToB64,
} from "./github.js";

interface Env {
  /** Admin worker base — provisioning lives at POST /api/provision (FGS has no /v1/publish). */
  ADMIN_BASE: string;
  /** VibeCode agent base — agent.freegamestore.online. Public; BYO AI key. */
  AGENT_BASE: string;
  GITHUB_ORG: string;
  /** The storefront repo holding registry.json (the ownership source of record). */
  STORE_REPO: string;
  MCP_OBJECT: DurableObjectNamespace;
  /** Org token with contents:write + workflow on the store org — powers the write
   *  tools (scaffold push + update_files + deploy.yml). Gated by verified ownership. */
  GITHUB_TOKEN?: string;
}

const DOMAIN = "freegamestore.online";

// GitHub Actions API (public repos, no auth needed)
async function getDeployStatus(org: string, gameId: string) {
  const res = await fetch(
    `https://api.github.com/repos/${org}/${gameId}/actions/runs?per_page=5`,
    { headers: { Accept: "application/vnd.github+json", "User-Agent": "freegamestore-mcp" } },
  );
  if (!res.ok) return { error: `GitHub API ${res.status}` };
  const data = (await res.json()) as {
    workflow_runs: Array<{ name: string; conclusion: string | null; status: string; updated_at: string; html_url: string; head_sha: string }>;
  };
  return (data.workflow_runs ?? []).map((r) => ({
    name: r.name,
    status: r.conclusion ?? r.status,
    updatedAt: r.updated_at,
    url: r.html_url,
    sha: r.head_sha?.slice(0, 7),
  }));
}

// POST to the admin worker (e.g. /api/provision — the same path `fgs publish` hits).
async function adminPost(adminBase: string, path: string, token: string, body: unknown) {
  const res = await fetch(`${adminBase}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) return { error: json.error ?? `API ${res.status}`, detail: json.detail ?? json.body ?? text, status: res.status };
  return json;
}

const txt = (text: string) => ({ content: [{ type: "text" as const, text }] });

// Scope VibeCode agent sessions to the caller. The agent worker keys its
// Durable Object by the raw session id with no per-user namespacing, so without
// this a passed/guessed session_id could reach another user's build session.
// Force every session under the caller's login; users can only ever
// create/read their own.
function sessionPrefix(login?: string): string {
  const u = (login ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "anon";
  return `mcp-${u}-`;
}

export interface McpProps extends Record<string, unknown> {
  login?: string; // GitHub login (decoded from the session token's `sub`)
  token?: string;
}

const TEMPLATES = ["canvas", "grid", "cards", "3d"] as const;
type Template = (typeof TEMPLATES)[number];

export class FgsMcpAgent extends McpAgent<Env, unknown, McpProps> {
  server = new McpServer({ name: "FreeGameStore", version: "0.1.0" });

  /** Called (via DO RPC) by the worker's fetch handler before each tool-call
   *  request is dispatched. agents@0.0.74's Streamable HTTP serve() doesn't
   *  propagate ctx.props, so we inject the authenticated session here — in
   *  memory (for this live instance) and storage (survives a restart). */
  async setAuth(props: McpProps): Promise<void> {
    this.props = props;
    try {
      await (this as unknown as { ctx: { storage: { put(k: string, v: unknown): Promise<void> } } }).ctx.storage.put("props", props);
    } catch {
      /* in-memory set is enough for the immediately-following tool call */
    }
  }

  /** Ownership gate: does the session user own this published game? FGS has no
   *  /v1/apps/mine — registry.json's per-game `creatorGithub` is the record. */
  private async ownsGame(gameId: string, login?: string): Promise<boolean> {
    if (!login) return false;
    const games = await readRegistryGames(this.env.GITHUB_ORG, this.env.STORE_REPO, this.env.GITHUB_TOKEN);
    return games.some((g) => g.id === gameId && g.creatorGithub === login);
  }

  async init() {
    // ── list_games ─────────────────────────────────────────────
    this.server.tool(
      "list_games",
      "List the games you've published on FreeGameStore (provisioned with your GitHub login as creator). Requires authentication (connect with an FGS session token).",
      {},
      async () => {
        const login = this.props.login;
        if (!this.props.token || !login)
          return txt("Not authenticated. Connect with an FGS session token to use this tool.");
        const games = (await readRegistryGames(this.env.GITHUB_ORG, this.env.STORE_REPO, this.env.GITHUB_TOKEN)).filter(
          (g) => g.creatorGithub === login,
        );
        if (games.length === 0) return txt("No games published yet under your login.");
        const lines = games.map(
          (g) => `- **${g.id}** (${g.category ?? "?"}) — ${g.oneliner ?? g.description ?? ""}\n  Live: ${g.appUrl ?? `https://${g.id}.${DOMAIN}`} | Repo: ${g.repo ?? `https://github.com/${this.env.GITHUB_ORG}/${g.id}`}`,
        );
        return txt(`${games.length} game(s):\n\n${lines.join("\n")}`);
      },
    );

    // ── deploy_status ──────────────────────────────────────────
    this.server.tool(
      "deploy_status",
      "Check the deploy status of a game (last 5 GitHub Actions runs). No auth needed for public repos.",
      { game_id: z.string().describe("Game ID (e.g. 'solitaire', 'tetris')") },
      async ({ game_id }) => {
        const runs = await getDeployStatus(this.env.GITHUB_ORG, game_id);
        if ("error" in runs) return txt(`Error: ${(runs as { error: string }).error}`);
        if ((runs as Array<unknown>).length === 0) return txt(`No workflow runs found for ${game_id}.`);
        const lines = (runs as Array<{ name: string; status: string; updatedAt: string; sha: string; url: string }>).map(
          (r) => `- ${r.status === "success" ? "✅" : r.status === "failure" ? "❌" : "⏳"} ${r.name} (${r.sha}) — ${r.updatedAt}\n  ${r.url}`,
        );
        return txt(`Deploy history for **${game_id}**:\n\n${lines.join("\n")}`);
      },
    );

    // ── game_info ──────────────────────────────────────────────
    this.server.tool(
      "game_info",
      "Get info about any game on FreeGameStore — live URL, repo, store listing, up/down status.",
      { game_id: z.string().describe("Game ID (e.g. 'solitaire', 'tetris')") },
      async ({ game_id }) => {
        const liveUrl = `https://${game_id}.${DOMAIN}`;
        const repoUrl = `https://github.com/${this.env.GITHUB_ORG}/${game_id}`;
        const listingUrl = `https://${DOMAIN}/games/${game_id}`;
        let status: string;
        try {
          const check = await fetch(liveUrl, { method: "HEAD" });
          status = check.ok ? "Live (200)" : `Down (${check.status})`;
        } catch {
          status = "Unreachable";
        }
        return txt(
          [
            `**${game_id}**`,
            `Status: ${status}`,
            `Live: ${liveUrl}`,
            `Repo: ${repoUrl}`,
            `Listing: ${listingUrl}`,
            `Deploy: push to main auto-deploys via GitHub Actions → R2 (Path B)`,
          ].join("\n"),
        );
      },
    );

    // ── game_logs ──────────────────────────────────────────────
    this.server.tool(
      "game_logs",
      "Get a game's recent deploy/build logs (latest GitHub Actions run + step status). FGS free-tier games have no server-side runtime log backend — for in-game errors use the browser console.",
      { game_id: z.string().describe("Game ID") },
      async ({ game_id }) => {
        const runs = await getDeployStatus(this.env.GITHUB_ORG, game_id);
        if ("error" in runs) return txt(`Error: ${(runs as { error: string }).error}`);
        const list = runs as Array<{ name: string; status: string; updatedAt: string; sha: string; url: string }>;
        if (list.length === 0) return txt(`No deploy runs found for ${game_id}.`);
        const latest = list[0];
        return txt(
          `Latest deploy for **${game_id}**: ${latest.status === "success" ? "✅ success" : latest.status === "failure" ? "❌ failure" : `⏳ ${latest.status}`} (${latest.sha}) — ${latest.updatedAt}\n` +
            `Logs: ${latest.url}\n\n` +
            `Note: FGS free-tier games have no runtime log backend. This shows build/deploy logs only; runtime errors surface in the browser console.`,
        );
      },
    );

    // ── platform_guide ─────────────────────────────────────────
    this.server.tool(
      "platform_guide",
      "Get the FreeGameStore platform guide (SKILLS.md) for AI-assisted game development. Returns the full guide for how to build games on the platform.",
      {},
      async () => {
        // FGS currently serves SKILLS.md (uppercase) only; lowercase is a sibling
        // alias on some deploys. Try both so this doesn't 404 on case.
        for (const path of ["/SKILLS.md", "/skills.md"]) {
          const res = await fetch(`https://${DOMAIN}${path}`);
          if (res.ok) return txt(await res.text());
        }
        return txt("Failed to fetch SKILLS.md");
      },
    );

    // ── sdk_reference ──────────────────────────────────────────
    this.server.tool(
      "sdk_reference",
      "Quick reference for @freegamestore/games — the shell, topbar, auth, sounds, leaderboard, and modal components every FGS game uses.",
      { feature: z.enum(["all", "shell", "topbar", "auth", "sounds", "leaderboard", "ui"]).optional().describe("Specific feature, or 'all' for the full reference") },
      async ({ feature }) => {
        const sections: Record<string, string> = {
          shell: `## GameShell — full-viewport wrapper
\`\`\`tsx
import { GameShell, GameTopbar, GameAuth } from '@freegamestore/games'
<GameShell topbar={<GameTopbar title="My Game" stats={[{label:'Score',value:score,accent:true}]} actions={<GameAuth/>} rules={<RulesPanel/>} />}>
  <div className="relative w-full h-full">{/* your game canvas */}</div>
</GameShell>
\`\`\`
GameShell owns the layout: a 44px topbar + a full-height game area below. No page scroll.`,
          topbar: `## GameTopbar — the single allowed topbar
\`\`\`tsx
<GameTopbar
  title="My Game"
  stats={[{ label: 'Score', value: score, accent: true }, { label: 'Best', value: best }]}
  actions={<GameAuth />}                 // ≤2 buttons; brand surface
  rules={<div>How to play…</div>}        // shows an ℹ info button → fullscreen overlay
  onPlayPause={togglePause} paused={paused}   // optional play/pause for real-time games
  onRestart={restart}                          // optional restart icon
/>
\`\`\`
Brand-consistent: same fonts/paddings/tokens across every game. Don't build your own bar.`,
          auth: `## GameAuth / identity
\`\`\`tsx
import { GameAuth, useAuth } from '@freegamestore/games'
<GameAuth />                                  // drop-in sign in / avatar button
const { user, loading, signIn, signOut } = useAuth()   // { id, login, avatarUrl } | null
\`\`\`
Sign in with GitHub. Used for leaderboards and per-user storage.`,
          sounds: `## useGameSounds — built-in SFX (respects the platform mute)
\`\`\`tsx
import { useGameSounds } from '@freegamestore/games'
const sounds = useGameSounds()
sounds.playMove(); sounds.playScore(); sounds.playClear(); sounds.playLevelUp(); sounds.playGameOver()
\`\`\`
The topbar mute toggle controls these — never play audio that ignores it.`,
          leaderboard: `## useLeaderboard — global scores
\`\`\`tsx
import { useLeaderboard, Leaderboard } from '@freegamestore/games'
const { submitScore, topScores, recentScores, loading } = useLeaderboard('my-game')
await submitScore(score)         // signed-in users get their name from the cookie
<Leaderboard gameId="my-game" />  // drop-in board UI
\`\`\``,
          ui: `## UI components
\`\`\`tsx
import { GameButton, GameModal, GameOverScreen, GameThemeToggle } from '@freegamestore/games'
<GameButton variant="primary" size="md" onClick={start}>Start</GameButton>
<GameModal open={open} onClose={close} title="Settings">…</GameModal>
<GameOverScreen score={score} best={best} onPlayAgain={restart} />
\`\`\`
Brand tokens: var(--paper), var(--ink), var(--accent). Dark mode + Manrope/Fraunces fonts come free.`,
        };
        const selected = feature === "all" || !feature ? Object.values(sections).join("\n\n") : sections[feature] ?? `Unknown feature: ${feature}`;
        return txt(`# @freegamestore/games Reference\n\n${selected}`);
      },
    );

    // ── create_game (provision + scaffold + go live) ───────────
    this.server.tool(
      "create_game",
      "Create AND publish a brand-new game on FreeGameStore, end to end. Provisions the GitHub repo + R2 hosting + store listing (same as `fgs publish`), scaffolds the chosen template, and pushes it so the game deploys live at <game_id>.freegamestore.online (~1-2 min). Then use read_file/update_files to build it out. Requires authentication.",
      {
        game_id: z.string().describe("Game slug: lowercase letters/numbers/hyphens, no 'free'/'pro' prefix. Becomes <game_id>.freegamestore.online"),
        category: z.string().describe("arcade, puzzle, board, card, action, strategy, casual, etc."),
        oneliner: z.string().describe("One-line description shown in the store"),
        template: z.enum(TEMPLATES).optional().describe("Starter template: canvas (default — action/arcade), grid (2048/minesweeper/sudoku), cards (solitaire/blackjack), or 3d (three.js)"),
        type: z.enum(["standalone", "connected"]).optional().describe("standalone (no backend, default) or connected (uses leaderboard/rooms)"),
        description: z.string().optional().describe("Longer description (defaults to the oneliner)"),
      },
      async ({ game_id, category, oneliner, template, type, description }) => {
        const token = this.props.token;
        if (!token) return txt("Not authenticated. Connect with an FGS session token to create games.");
        if (!this.env.GITHUB_TOKEN) return txt("Write tools are disabled (server missing GITHUB_TOKEN).");
        const tmpl: Template = template ?? "canvas";
        const kind = type ?? "standalone";
        // 1. Provision via the admin endpoint `fgs publish` uses. Pass
        //    creatorGithub so the registry records ownership (the update_files gate).
        //
        //    NOTE (CF Access future-proofing): this calls admin.freegamestore.online
        //    DIRECTLY with the user's Bearer, which works only because FGS admin is
        //    currently Bearer-gated (401 on bad token), not behind CF Access. If admin
        //    is later put behind CF Access, this request will 302 at the edge BEFORE
        //    the worker runs and create_game will break. At that point switch to the
        //    FAS pattern: call a PUBLIC backend endpoint that service-binds to admin
        //    (CF Access applies at the public edge, not to service bindings).
        const prov = (await adminPost(this.env.ADMIN_BASE, "/api/provision", token, {
          name: game_id,
          store: "games",
          category,
          type: kind,
          oneliner,
          description: description || oneliner,
          repo: null,
          demo: null,
          creatorGithub: this.props.login ?? null,
        })) as { error?: string; detail?: unknown; appUrl?: string; repoUrl?: string };
        if (prov.error)
          return txt(`Provision failed: ${prov.error}${prov.detail ? ` — ${typeof prov.detail === "string" ? prov.detail : JSON.stringify(prov.detail)}` : ""}`);
        // 2. Scaffold the chosen template: fetch → substitute APPNAME → push.
        //    This also fixes any unsubstituted placeholders from the admin's
        //    canvas generate, and applies grid/cards/3d when chosen.
        try {
          const files = await fetchTemplateFiles(this.env.GITHUB_ORG, `template-game-${tmpl}`, this.env.GITHUB_TOKEN, game_id);
          // replaceTree: the admin generates the repo from template-game-canvas;
          // a full-tree replace ensures a grid/cards/3d game contains ONLY the
          // chosen template (no leftover canvas files with unsubstituted APPNAME).
          //
          await pushFiles(this.env.GITHUB_ORG, game_id, this.env.GITHUB_TOKEN, files, `Initial ${game_id} — scaffolded via MCP (${tmpl})`, true);
          return txt(
            `✅ Created **${game_id}** (${tmpl} template, ${kind}).\n` +
              `Live in ~1-2 min: https://${game_id}.${DOMAIN}\n` +
              `Repo: https://github.com/${this.env.GITHUB_ORG}/${game_id}\n` +
              `Listing: https://${DOMAIN}/games/${game_id}\n\n` +
              `Scaffolded ${files.size} files. Next: \`list_files\`/\`read_file\` to inspect, \`update_files\` to build it out, \`deploy_status\` to watch it deploy.`,
          );
        } catch (e) {
          return txt(`Provisioned the repo + hosting, but the scaffold push failed: ${String(e)}\nThe game exists — retry by pushing files with update_files.`);
        }
      },
    );

    // ── list_files ─────────────────────────────────────────────
    this.server.tool(
      "list_files",
      "List the files in a game's repo (so you know what to read/edit).",
      { game_id: z.string().describe("Game ID") },
      async ({ game_id }) => {
        const files = await listRepoFiles(this.env.GITHUB_ORG, game_id, this.env.GITHUB_TOKEN);
        if (files.length === 0) return txt(`No files found for ${game_id} (repo empty or not found).`);
        return txt(`**${game_id}** — ${files.length} files:\n\n${files.map((f) => `- ${f}`).join("\n")}`);
      },
    );

    // ── read_file ──────────────────────────────────────────────
    this.server.tool(
      "read_file",
      "Read one file's contents from a game's repo (e.g. web/src/App.tsx).",
      { game_id: z.string().describe("Game ID"), path: z.string().describe("File path relative to repo root, e.g. web/src/App.tsx") },
      async ({ game_id, path }) => {
        const content = await readRepoFile(this.env.GITHUB_ORG, game_id, this.env.GITHUB_TOKEN, path);
        if (content === null) return txt(`Could not read ${path} from ${game_id} (not found?).`);
        return txt(`\`\`\`\n${content}\n\`\`\``);
      },
    );

    // ── update_files (improve loop) ────────────────────────────
    this.server.tool(
      "update_files",
      "Improve a game you own: write/overwrite one or more files in its repo with full new contents. The push auto-deploys to <game_id>.freegamestore.online in ~30-60s. Requires authentication + ownership.",
      {
        game_id: z.string().describe("Game ID (must be one you published)"),
        files: z.array(z.object({ path: z.string(), content: z.string() })).describe("Files to write — each with the FULL new content. Paths relative to repo root, e.g. web/src/App.tsx"),
        message: z.string().optional().describe("Commit message"),
      },
      async ({ game_id, files, message }) => {
        const token = this.props.token;
        if (!token) return txt("Not authenticated. Connect with an FGS session token.");
        if (!this.env.GITHUB_TOKEN) return txt("Write tools are disabled (server missing GITHUB_TOKEN).");
        if (!files?.length) return txt("No files provided.");
        if (!(await this.ownsGame(game_id, this.props.login)))
          return txt(`You don't own "${game_id}" (or it isn't registered to your login). Only the creator can update it.`);
        const map = new Map<string, RepoFile>(files.map((f) => [f.path, { content: textToB64(f.content), encoding: "base64" as const }]));
        try {
          const sha = await pushFiles(this.env.GITHUB_ORG, game_id, this.env.GITHUB_TOKEN, map, message || `Update ${game_id} via MCP`);
          return txt(`✅ Pushed ${files.length} file(s) to **${game_id}** (${sha.slice(0, 7)}). Auto-deploying to https://${game_id}.${DOMAIN} (~30-60s). Use deploy_status to watch.`);
        } catch (e) {
          return txt(`Push failed: ${String(e)}`);
        }
      },
    );

    // ── agent_build (delegate code-gen to the platform's VibeCode agent) ──
    this.server.tool(
      "agent_build",
      "Hand a natural-language prompt to the FreeGameStore VibeCode AGENT — the platform's own AI writes the game code AND deploys it. Different from create_game/update_files (where the CALLING model writes the code): here you just prompt and the platform builds. FGS's agent is bring-your-own-key (no vault yet): pass an `api_key` for the chosen provider. Long-running; builds in the background. Returns a session_id — poll agent_status for progress + the live URL. Tip: include the game id in your prompt, e.g. 'Build a memory match game and deploy it as memory-match'.",
      {
        prompt: z.string().describe("What to build, in plain English. Include a desired game id."),
        api_key: z.string().describe("Your AI provider API key (bring-your-own — FGS's agent has no key vault yet). Spent against your own account."),
        provider: z.enum(["anthropic", "openai", "google", "github"]).optional().describe("AI provider for your key (default anthropic)."),
        model: z.string().optional().describe("Model id (defaults per provider, e.g. claude-sonnet-4-6)"),
        session_id: z.string().optional().describe("Continue an existing build session"),
      },
      async ({ prompt, api_key, provider, model, session_id }) => {
        if (!this.props.token) return txt("Not authenticated. Connect with an FGS session token.");
        if (!api_key) return txt("agent_build needs an `api_key` — FGS's VibeCode agent is bring-your-own-key (no vault yet).");
        const prov = provider ?? "anthropic";
        const defaultModel: Record<string, string> = {
          anthropic: "claude-sonnet-4-6",
          openai: "gpt-4o",
          google: "gemini-2.0-flash",
          github: "gpt-4o",
        };
        // Force the session under the caller's namespace: a passed session_id
        // is honored only if already in the caller's namespace, else re-scoped —
        // so you can't target another user's session id.
        const prefix = sessionPrefix(this.props.login);
        const sid = session_id
          ? session_id.startsWith(prefix)
            ? session_id
            : prefix + session_id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)
          : prefix + crypto.randomUUID().slice(0, 12);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 110_000); // cap; build continues server-side
        const phases: string[] = [];
        let gameId: string | null = null;
        let timedOut = false;
        try {
          const res = await fetch(`${this.env.AGENT_BASE}/session/${sid}/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: prompt, aiConfig: { provider: prov, model: model ?? defaultModel[prov] ?? "claude-sonnet-4-6", apiKey: api_key } }),
            signal: ctrl.signal,
          });
          if (!res.ok || !res.body) {
            clearTimeout(timer);
            return txt(`Agent chat failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
          }
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const parts = buf.split("\n\n");
            buf = parts.pop() ?? "";
            for (const p of parts) {
              const line = p.split("\n").find((l) => l.startsWith("data: "));
              if (!line) continue;
              try {
                const ev = JSON.parse(line.slice(6));
                if ((ev.type === "deploy_status" || ev.type === "deploy") && ev.data) {
                  const d = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
                  if (d.phase) phases.push(d.phase);
                  if (d.appId) gameId = d.appId;
                }
                if (ev.appId) gameId = ev.appId;
              } catch { /* */ }
            }
          }
        } catch {
          timedOut = true; // aborted at the cap — the agent keeps building server-side
        }
        clearTimeout(timer);
        const last = phases[phases.length - 1];
        const liveLine = gameId ? `Live (when built): https://${gameId}.${DOMAIN}` : "";
        return txt(
          `${timedOut ? "⏳ Agent still building" : "✓ Agent turn finished"} (session \`${sid}\`).\n` +
            (gameId ? `Game: **${gameId}**\n` : "") +
            (last ? `Last deploy phase: ${last}\n` : "") +
            `${liveLine}\n\nPoll \`agent_status\` with session_id="${sid}" for progress + the live URL.`,
        );
      },
    );

    // ── agent_status ───────────────────────────────────────────
    this.server.tool(
      "agent_status",
      "Check a VibeCode agent build session (started with agent_build): the game id it's building, deploy phase, and live URL once ready.",
      { session_id: z.string().describe("The session_id returned by agent_build") },
      async ({ session_id }) => {
        if (!this.props.token) return txt("Not authenticated. Connect with an FGS session token.");
        // Only let callers read sessions in their own namespace.
        if (!session_id.startsWith(sessionPrefix(this.props.login)))
          return txt("That session isn't one of yours — agent sessions are scoped to your account. Use the session_id returned by agent_build.");
        const res = await fetch(`${this.env.AGENT_BASE}/session/${session_id}/status`, {
          headers: { Authorization: `Bearer ${this.props.token}` },
        });
        if (!res.ok) return txt(`Status fetch failed (${res.status}).`);
        const s = (await res.json()) as { appId?: string | null; appUrl?: string | null; deployStatus?: { phase?: string; error?: string } | null; messageCount?: number };
        const lines = [
          `Session **${session_id}**`,
          `Game: ${s.appId ?? "(not deployed yet)"}`,
          `Deploy phase: ${s.deployStatus?.phase ?? "—"}${s.deployStatus?.error ? ` (error: ${s.deployStatus.error.slice(0, 200)})` : ""}`,
          s.appUrl ? `Live: ${s.appUrl}` : s.appId ? `URL (once live): https://${s.appId}.${DOMAIN}` : "",
          `Messages: ${s.messageCount ?? 0}`,
        ].filter(Boolean);
        return txt(lines.join("\n"));
      },
    );
  }
}

// ── Auth middleware ─────────────────────────────────────────────
// Pass the Bearer session token into the DO as a prop. We do NOT locally verify
// it: the admin worker is the source of truth — every authenticated tool calls
// it (provision) or GitHub (registry/repos), and it rejects invalid/expired
// tokens. The MCP doesn't hold the admin's HS256 signing key (never exported),
// so local verification can't work anyway. We decode the GitHub login from the
// token's `sub` claim best-effort, purely for context + the ownership gate.
function decodeLogin(token: string): string | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=")));
    return typeof json.sub === "string" ? json.sub : undefined;
  } catch {
    return undefined;
  }
}

function authenticateRequest(request: Request): { login?: string; token?: string } {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return {};
  const token = auth.slice(7).trim();
  if (!token) return {};
  return { login: decodeLogin(token), token };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "FreeGameStore MCP Server\n\nConnect: npx mcp-remote https://mcp.freegamestore.online/mcp\n\n" +
          "Build it yourself (your model writes the code): create_game, update_files, read_file, list_files\n" +
          "Let the platform agent build it (you just prompt): agent_build, agent_status\n" +
          "Info: list_games, deploy_status, game_info, game_logs, platform_guide, sdk_reference\n\n" +
          "Two ways to build, both from your editor:\n" +
          "  1. create_game → read_file/update_files to improve → deploy_status.\n" +
          "  2. agent_build('make a X game and deploy it') → the VibeCode agent writes + ships it → agent_status.\n\n" +
          "Auth: pass Authorization: Bearer <FGS session token> for authenticated tools.\n",
        { headers: { "content-type": "text/plain" } },
      );
    }

    // Authenticate and inject the session into the target MCP DO before
    // dispatch. Streamable HTTP serve() in agents@0.0.74 drops ctx.props, so we
    // write props straight into the DO (keyed the same way serve() keys it:
    // `streamable-http:${mcp-session-id}`). The session id is present on every
    // post-initialize request (i.e. all tool calls).
    if (url.pathname.startsWith("/mcp")) {
      const auth = authenticateRequest(request);
      const sessionId = request.headers.get("mcp-session-id");
      if (auth.token && sessionId) {
        try {
          const id = env.MCP_OBJECT.idFromName(`streamable-http:${sessionId}`);
          const stub = env.MCP_OBJECT.get(id) as unknown as { setAuth(p: McpProps): Promise<void> };
          await stub.setAuth({ login: auth.login, token: auth.token });
        } catch {
          /* best effort — tool will report "not authenticated" if this failed */
        }
      }
      return FgsMcpAgent.serve("/mcp").fetch(request, env, ctx);
    }

    return FgsMcpAgent.serve("/mcp").fetch(request, env, ctx);
  },
};
