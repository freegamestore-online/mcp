import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchTemplateFiles, listRepoFiles, pushFiles, readRegistryGames, readRepoFile, type RepoFile, textToB64 } from "./github.js";
import { handleOAuthRoute, resolveOAuthToken, unauthorizedChallenge } from "./oauth-provider.js";

interface Env {
  API_BASE: string;
  GITHUB_ORG: string;
  AGENT_BASE: string;
  LEADERBOARD_BASE: string;
  STORE_REPO: string;
  MCP_OBJECT: DurableObjectNamespace;
  GITHUB_TOKEN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  OAUTH_KV?: KVNamespace;
}

// GitHub Actions API (public repos, no auth needed)
async function getDeployStatus(org: string, gameId: string) {
  const res = await fetch(
    `https://api.github.com/repos/${org}/${gameId}/actions/runs?per_page=5`,
    { headers: { Accept: "application/vnd.github+json", "User-Agent": "freegamestore-mcp" } }
  );
  if (!res.ok) return { error: `GitHub API ${res.status}` };
  let data: { workflow_runs?: Array<{ name: string; conclusion: string | null; status: string; updated_at: string; html_url: string; head_sha: string }> };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return { error: "GitHub API returned invalid JSON" };
  }
  return (data.workflow_runs ?? []).map((r) => ({
    name: r.name,
    status: r.conclusion ?? r.status,
    updatedAt: r.updated_at,
    url: r.html_url,
    sha: r.head_sha?.slice(0, 7),
  }));
}

// FGS admin API
async function fgsApi(apiBase: string, path: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${apiBase}${path}`, { headers });
  if (!res.ok) return { error: `API ${res.status}: ${await res.text()}` };
  // Handle 204 No Content (e.g. /api/quality when no audit data exists)
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: `Invalid JSON from ${path}: ${text.slice(0, 200)}` };
  }
}

// POST to the FGS admin
async function fgsPost(apiBase: string, path: string, token: string, body: unknown) {
  const res = await fetch(`${apiBase}${path}`, {
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

// Scope VibeCode agent sessions to the caller.
function sessionPrefix(userId?: string): string {
  const u = (userId ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "anon";
  return `mcp-${u}-`;
}

// Decode userId from FGS admin JWT (3-part: header.payload.sig)
function decodeUid(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(padded + "===".slice(0, (4 - padded.length % 4) % 4)));
    return typeof json.sub === "string" ? json.sub : undefined;
  } catch {
    return undefined;
  }
}

export interface McpProps extends Record<string, unknown> {
  userId?: string;
  token?: string;
}

export class FgsMcpAgent extends McpAgent<Env, unknown, McpProps> {
  server = new McpServer({
    name: "FreeGameStore",
    version: "0.1.0",
  });

  async setAuth(props: McpProps): Promise<void> {
    this.props = props;
    try {
      await (this as unknown as { ctx: { storage: { put(k: string, v: unknown): Promise<void> } } }).ctx.storage.put("props", props);
    } catch {
      /* in-memory set is enough for the immediately-following tool call */
    }
  }

  /** Ownership gate: does the session user own this published game?
   *  FGS has no /v1/apps/mine — registry.json's creatorGithub is the record. */
  private async ownsGame(gameId: string): Promise<boolean> {
    const login = this.props.userId;
    if (!login) return false;
    const games = await readRegistryGames(this.env.GITHUB_ORG, this.env.STORE_REPO, this.env.GITHUB_TOKEN);
    return games.some((g) => g.id === gameId && g.creatorGithub === login);
  }

  async init() {
    // -- list_games --
    this.server.tool(
      "list_games",
      "List all published games on FreeGameStore (from the store registry). No auth needed.",
      {},
      async () => {
        const data = (await fgsApi(this.env.API_BASE, "/api/status")) as
          | Array<{ id: string; name: string; domain: string; org: string }>
          | { error: string };
        if (!Array.isArray(data)) return txt(`Error: ${(data as { error: string }).error ?? "unexpected response"}`);
        const games = data as Array<{ id: string; name: string; domain: string; org: string }>;
        if (games.length === 0) return txt("No games published yet.");
        const lines = games.map(
          (g) => `- **${g.name}** (${g.id}) — https://${g.domain}`
        );
        return txt(`${games.length} game(s):\n\n${lines.join("\n")}`);
      }
    );

    // -- deploy_status --
    this.server.tool(
      "deploy_status",
      "Check the deploy status of a game (last 5 GitHub Actions runs). No auth needed for public repos.",
      { game_id: z.string().describe("Game ID (e.g. 'chess', 'tetris')") },
      async ({ game_id }) => {
        const runs = await getDeployStatus(this.env.GITHUB_ORG, game_id);
        if (!Array.isArray(runs)) return txt(`Error: ${(runs as { error: string }).error}`);
        if (runs.length === 0)
          return txt(`No workflow runs found for ${game_id}.`);
        const lines = runs.map(
          (r) => `- ${r.status === "success" ? "OK" : r.status === "failure" ? "FAIL" : "..."} ${r.name} (${r.sha}) — ${r.updatedAt}\n  ${r.url}`
        );
        return txt(`Deploy history for **${game_id}**:\n\n${lines.join("\n")}`);
      }
    );

    // -- game_info --
    this.server.tool(
      "game_info",
      "Get info about any game on FreeGameStore — live URL, repo, store listing.",
      { game_id: z.string().describe("Game ID (e.g. 'chess', 'tetris')") },
      async ({ game_id }) => {
        const domain = "freegamestore.online";
        const org = this.env.GITHUB_ORG;
        const liveUrl = `https://${game_id}.${domain}`;
        const repoUrl = `https://github.com/${org}/${game_id}`;
        const listingUrl = `https://${domain}/games/${game_id}`;

        let status: string;
        try {
          const check = await fetch(liveUrl, { method: "HEAD" });
          status = check.ok ? "Live (200)" : `Down (${check.status})`;
        } catch {
          status = "Unreachable";
        }

        return {
          content: [{
            type: "text" as const,
            text: [
              `**${game_id}**`,
              `Status: ${status}`,
              `Live: ${liveUrl}`,
              `Repo: ${repoUrl}`,
              `Listing: ${listingUrl}`,
              `Deploy: push to main auto-deploys via GitHub Actions -> R2`,
            ].join("\n"),
          }],
        };
      }
    );

    // -- game_quality --
    this.server.tool(
      "game_quality",
      "Get quality audit results for games (scores, load times, console errors). No auth needed.",
      { game_id: z.string().optional().describe("Game ID to filter (omit for all games)") },
      async ({ game_id }) => {
        const data = (await fgsApi(this.env.API_BASE, "/api/quality")) as
          | { timestamp: string; games: Array<{ id: string; score: number; loadTimeMs: number; consoleErrors: string[] }> }
          | { error: string }
          | null;
        if (!data || typeof data !== "object") return txt("No quality audit data available yet.");
        if ("error" in data) return txt(`Error: ${(data as { error: string }).error}`);
        const qd = data as { timestamp: string; games: Array<{ id: string; score: number; loadTimeMs: number; consoleErrors: string[] }> };
        if (!qd.games) return txt("No quality audit data available yet.");
        let games = qd.games ?? [];
        if (game_id) games = games.filter((g) => g.id === game_id);
        if (games.length === 0) return txt(game_id ? `No quality data for ${game_id}.` : "No quality data available.");
        const lines = games.map((g) => {
          const errs = g.consoleErrors ?? [];
          const errors = errs.length > 0 ? ` | Errors: ${errs.join(", ")}` : "";
          return `- **${g.id}**: score ${g.score}/100, load ${g.loadTimeMs}ms${errors}`;
        });
        return txt(`Quality audit (${qd.timestamp}):\n\n${lines.join("\n")}`);
      }
    );

    // -- leaderboard --
    this.server.tool(
      "leaderboard",
      "Query the leaderboard for a game — top scores and recent scores.",
      {
        game_id: z.string().describe("Game ID"),
        limit: z.number().optional().describe("Max entries (default 10)"),
      },
      async ({ game_id, limit }) => {
        const n = limit ?? 10;
        const res = await fetch(
          `${this.env.LEADERBOARD_BASE}/api/leaderboard/${game_id}?limit=${n}`,
          { headers: { "User-Agent": "freegamestore-mcp" } }
        );
        if (!res.ok) return txt(`Leaderboard API error: ${res.status}`);
        let data: { scores?: Array<{ name: string; score: number; created_at: string }> };
        try {
          data = (await res.json()) as typeof data;
        } catch {
          return txt(`Leaderboard API returned invalid JSON.`);
        }
        const scores = data.scores ?? [];
        if (scores.length === 0) return txt(`No leaderboard entries for ${game_id}.`);
        const lines = scores.map(
          (s, i) => `${i + 1}. **${s.name}** — ${s.score} (${new Date(s.created_at).toLocaleDateString()})`
        );
        return txt(`Leaderboard for **${game_id}** (top ${scores.length}):\n\n${lines.join("\n")}`);
      }
    );

    // -- platform_guide --
    this.server.tool(
      "platform_guide",
      "Get the FreeGameStore platform guide for AI-assisted game development.",
      {},
      async () => {
        for (const path of ["/SKILLS.md", "/skills.md"]) {
          const res = await fetch(`https://freegamestore.online${path}`);
          if (res.ok) return txt(await res.text());
          await res.body?.cancel();
        }
        return txt("Failed to fetch SKILLS.md from freegamestore.online.");
      }
    );

    // -- sdk_reference --
    this.server.tool(
      "sdk_reference",
      "Quick reference for @freegamestore/games SDK — imports, features, and usage patterns for auth, leaderboard, sound, and UI components.",
      { feature: z.enum(["all", "shell", "auth", "leaderboard", "sound", "ui"]).optional().describe("Specific feature, or 'all'") },
      async ({ feature }) => {
        const sections: Record<string, string> = {
          shell: `## GameShell + GameTopbar (required wrapper)
\`\`\`tsx
import { GameShell, GameTopbar, GameAuth } from '@freegamestore/games'

<GameShell topbar={
  <GameTopbar
    title="My Game"
    score={42}                           // shorthand for a single "Score" stat
    stats={[                             // or pass custom stats array
      { label: "SCORE", value: score, accent: true },
      { label: "BEST", value: best },
    ]}
    actions={<GameAuth />}               // right-side slot (sign-in button)
    rules={<div>How to play...</div>}    // info button -> fullscreen overlay
    onRestart={restart}                  // restart icon
    onPlayPause={toggle} paused={isPaused} // play/pause for real-time games
  />
}>
  <YourGameBoard />
</GameShell>
\`\`\`
GameShell: fixed 100svh layout, SoundProvider context, overflow hidden. GameTopbar: brand-consistent bar (don't build your own).`,
          auth: `## Auth
\`\`\`tsx
import { GameAuth, useAuth } from '@freegamestore/games'

<GameAuth />  // drop-in sign-in / avatar button

const { user, loading, signIn, signOut } = useAuth()
// user: { id: string, name: string, avatar: string } | null
// signIn() redirects to auth.freegamestore.online (GitHub OAuth)
\`\`\``,
          leaderboard: `## Leaderboard
\`\`\`tsx
import { useLeaderboard, Leaderboard } from '@freegamestore/games'

const { topScores, recentScores, submitScore, loading, refresh } = useLeaderboard('my-game')
await submitScore(1500)  // signed-in users get their name from the auth cookie

// Drop-in board UI:
<Leaderboard topScores={topScores} recentScores={recentScores} loading={loading} />
\`\`\``,
          sound: `## Sound
\`\`\`tsx
import { useSound, useGameSounds } from '@freegamestore/games'

// Mute state (controlled by topbar toggle):
const { muted, toggle } = useSound()

// Synthesized Web Audio effects (zero audio files, respect mute automatically):
const sounds = useGameSounds()
sounds.playMove()      // click/tap — piece moved, card flipped
sounds.playScore()     // positive ding — scored, matched
sounds.playError()     // negative buzz — wrong, hit obstacle
sounds.playDrop()      // thud — block landed
sounds.playClear()     // sweep — line cleared, combo
sounds.playLevelUp()   // ascending arpeggio — level up
sounds.playGameOver()  // descending tones — game over
sounds.playTick()      // countdown tick
\`\`\`
IMPORTANT: useGameSounds() must be called inside GameShell (needs SoundProvider context). Put game logic in a child component of GameShell.`,
          ui: `## UI Components
\`\`\`tsx
import {
  GameButton, GameConfirm, GameModal, GameOverScreen,
  GameTextSizeToggle, GameThemeToggle,
} from '@freegamestore/games'

<GameButton variant="primary" size="md" onClick={start}>Play</GameButton>
<GameButton variant="ghost" size="sm" onClick={skip}>Skip</GameButton>
<GameConfirm open={show} title="Restart?" message="Progress will be lost"
  onConfirm={restart} onCancel={close} variant="danger" />
<GameModal open={settingsOpen} onClose={close} title="Settings">...</GameModal>
<GameOverScreen score={score} highScore={best} onPlayAgain={restart} />
<GameTextSizeToggle />
<GameThemeToggle />
\`\`\`
Variants: primary | secondary | ghost | danger. Sizes: sm | md | lg.`,
        };

        const selected = feature === "all" || !feature
          ? Object.values(sections).join("\n\n")
          : sections[feature] ?? `Unknown feature: ${feature}`;

        return txt(`# @freegamestore/games SDK Reference\n\n${selected}`);
      }
    );

    // -- create_game (provision + scaffold + go live) --
    this.server.tool(
      "create_game",
      "Create AND publish a brand-new game on FreeGameStore, end to end. Provisions the GitHub repo + R2 hosting + store listing, scaffolds the chosen template, and pushes it so the game deploys live at <game_id>.freegamestore.online (~1-2 min). Then use read_file/update_files to build it out. Requires authentication.",
      {
        game_id: z.string().describe("Game slug: lowercase letters/numbers/hyphens. Becomes <game_id>.freegamestore.online"),
        name: z.string().describe("Display name (e.g. 'Chess', 'Space Invaders')"),
        category: z.string().describe("puzzle, arcade, strategy, card, board, trivia, racing, sports, action, simulation, or educational"),
        description: z.string().optional().describe("Short description"),
        template: z.enum(["canvas", "3d", "grid", "cards", "phaser", "kaplay", "pixi", "babylon"]).optional().describe("Game template (default: canvas)"),
      },
      async ({ game_id, name, category, description, template }) => {
        const token = this.props.token;
        if (!token) return txt("Not authenticated. Connect with a FGS session token to create games.");
        if (!this.env.GITHUB_TOKEN) return txt("Write tools are disabled (server missing GITHUB_TOKEN).");

        const templateRepo = `template-game-${template ?? "canvas"}`;

        // 1. Provision via admin API (pass creatorGithub so admin grants push access)
        const prov = (await fgsPost(this.env.API_BASE, "/api/provision", token, {
          id: game_id,
          name,
          category,
          description: description || name,
          oneliner: description || name,
          creatorGithub: this.props.userId,
        })) as { error?: string; detail?: string; success?: boolean; appUrl?: string; repoUrl?: string };
        if (prov.error) return txt(`Provision failed: ${prov.error}${prov.detail ? ` — ${typeof prov.detail === "string" ? prov.detail : JSON.stringify(prov.detail)}` : ""}`);

        // 2. Scaffold: fetch template, substitute, push -> triggers deploy
        try {
          const files = await fetchTemplateFiles(this.env.GITHUB_ORG, templateRepo, this.env.GITHUB_TOKEN, game_id);
          await pushFiles(this.env.GITHUB_ORG, game_id, this.env.GITHUB_TOKEN, files, `Initial ${game_id} — scaffolded via MCP (${templateRepo})`, true);
          return txt(
            `Created **${name}** (${game_id}) using ${templateRepo}.\n` +
            `Live in ~1-2 min: https://${game_id}.freegamestore.online\n` +
            `Repo: https://github.com/${this.env.GITHUB_ORG}/${game_id}\n` +
            `Listing: https://freegamestore.online/games/${game_id}\n\n` +
            `Scaffolded ${files.size} files. Next: \`list_files\`/\`read_file\` to inspect, \`update_files\` to build it out, \`deploy_status\` to watch it deploy.`,
          );
        } catch (e) {
          return txt(`Provisioned the repo + hosting, but the scaffold push failed: ${String(e)}\nThe game exists — retry by pushing files with update_files.`);
        }
      },
    );

    // -- list_files --
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

    // -- read_file --
    this.server.tool(
      "read_file",
      "Read one file's contents from a game's repo (e.g. web/src/App.tsx).",
      { game_id: z.string().describe("Game ID"), path: z.string().describe("File path relative to repo root") },
      async ({ game_id, path }) => {
        const content = await readRepoFile(this.env.GITHUB_ORG, game_id, this.env.GITHUB_TOKEN, path);
        if (content === null) return txt(`Could not read ${path} from ${game_id} (not found?).`);
        const ext = path.split(".").pop() ?? "";
        return txt(`\`\`\`${ext}\n${content}\n\`\`\``);
      },
    );

    // -- update_files --
    this.server.tool(
      "update_files",
      "Improve a game: write/overwrite one or more files in its repo with full new contents. The push auto-deploys to <game_id>.freegamestore.online in ~30-60s. Requires authentication.",
      {
        game_id: z.string().describe("Game ID"),
        files: z.array(z.object({ path: z.string(), content: z.string() })).describe("Files to write — each with the FULL new content"),
        message: z.string().optional().describe("Commit message"),
      },
      async ({ game_id, files, message }) => {
        const token = this.props.token;
        if (!token) return txt("Not authenticated. Connect with a FGS session token.");
        if (!this.env.GITHUB_TOKEN) return txt("Write tools are disabled (server missing GITHUB_TOKEN).");
        if (!files?.length) return txt("No files provided.");
        if (!(await this.ownsGame(game_id)))
          return txt(`You don't own "${game_id}" (or it isn't registered to your login). Only the creator can update it.`);
        const map = new Map<string, RepoFile>(
          files.map((f) => [f.path, { content: textToB64(f.content), encoding: "base64" as const }]),
        );
        try {
          const sha = await pushFiles(this.env.GITHUB_ORG, game_id, this.env.GITHUB_TOKEN, map, message || `Update ${game_id} via MCP`);
          return txt(`Pushed ${files.length} file(s) to **${game_id}** (${sha.slice(0, 7)}). Auto-deploying to https://${game_id}.freegamestore.online (~30-60s). Use deploy_status to watch.`);
        } catch (e) {
          return txt(`Push failed: ${String(e)}`);
        }
      },
    );

    // -- agent_build (delegate code-gen to the platform's VibeCode agent) --
    this.server.tool(
      "agent_build",
      "Hand a natural-language prompt to the FreeGameStore VibeCode AGENT — the platform's own AI writes the code AND deploys it. FGS agent is bring-your-own-key: pass your AI provider api_key. Long-running; builds in the background. Returns session_id — poll agent_status for progress.",
      {
        prompt: z.string().describe("What to build, in plain English. Include a desired game id."),
        api_key: z.string().describe("Your AI provider API key (BYO — FGS agent has no key vault). Spent against your own account."),
        provider: z.enum(["anthropic", "openai", "google", "github"]).optional().describe("AI provider for your key (default anthropic)"),
        model: z.string().optional().describe("Model id"),
        session_id: z.string().optional().describe("Continue an existing build session"),
      },
      async ({ prompt, api_key, provider, model, session_id }) => {
        const token = this.props.token;
        if (!token) return txt("Not authenticated. Connect with a FGS session token.");
        if (!api_key) return txt("agent_build requires an api_key — FGS agent is bring-your-own-key.");
        const prov = provider ?? "anthropic";
        const defaultModel: Record<string, string> = {
          anthropic: "claude-sonnet-4-6",
          openai: "gpt-4o",
          google: "gemini-2.0-flash",
          github: "gpt-4o",
        };
        const prefix = sessionPrefix(this.props.userId);
        const sid = session_id
          ? session_id.startsWith(prefix)
            ? session_id
            : prefix + session_id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)
          : prefix + crypto.randomUUID().slice(0, 12);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 110_000);
        let phases: string[] = [];
        let gameId: string | null = null;
        let timedOut = false;
        try {
          const res = await fetch(`${this.env.AGENT_BASE}/session/${sid}/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
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
                if ((ev.type === "deploy" || ev.type === "deploy_status") && ev.data) {
                  try {
                    const d = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
                    if (d.phase) phases.push(d.phase);
                    if (d.appId) gameId = d.appId;
                  } catch { /* */ }
                }
                if (ev.appId) gameId = ev.appId;
              } catch { /* */ }
            }
          }
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            timedOut = true;
          } else {
            clearTimeout(timer);
            return txt(`Agent request failed: ${String(err)}`);
          }
        }
        clearTimeout(timer);
        const last = phases[phases.length - 1];
        const liveLine = gameId ? `Live (when built): https://${gameId}.freegamestore.online` : "";
        return txt(
          `${timedOut ? "Agent still building" : "Agent turn finished"} (session \`${sid}\`).\n` +
          (gameId ? `Game: **${gameId}**\n` : "") +
          (last ? `Last deploy phase: ${last}\n` : "") +
          `${liveLine}\n\nPoll \`agent_status\` with session_id="${sid}" for progress + the live URL.`,
        );
      },
    );

    // -- agent_status --
    this.server.tool(
      "agent_status",
      "Check a VibeCode agent build session (started with agent_build): the game id, deploy phase, and live URL.",
      { session_id: z.string().describe("The session_id returned by agent_build") },
      async ({ session_id }) => {
        const token = this.props.token;
        if (!token) return txt("Not authenticated. Connect with a FGS session token.");
        if (!session_id.startsWith(sessionPrefix(this.props.userId)))
          return txt("That session isn't one of yours — agent sessions are scoped to your account.");
        const res = await fetch(`${this.env.AGENT_BASE}/session/${session_id}/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return txt(`Status fetch failed (${res.status}).`);
        let s: { appId?: string | null; appUrl?: string | null; deployStatus?: { phase?: string; error?: string } | null; messageCount?: number };
        try {
          s = (await res.json()) as typeof s;
        } catch {
          return txt("Agent status returned invalid JSON.");
        }
        const lines = [
          `Session **${session_id}**`,
          `Game: ${s.appId ?? "(not deployed yet)"}`,
          `Deploy phase: ${s.deployStatus?.phase ?? "—"}${s.deployStatus?.error ? ` (error: ${s.deployStatus.error.slice(0, 200)})` : ""}`,
          s.appUrl ? `Live: ${s.appUrl}` : s.appId ? `URL (once live): https://${s.appId}.freegamestore.online` : "",
          `Messages: ${s.messageCount ?? 0}`,
        ].filter(Boolean);
        return txt(lines.join("\n"));
      },
    );
  }
}

// -- Auth middleware --
// FGS admin sessions are 3-part JWTs (header.payload.sig), HMAC-SHA256 signed
// with the admin's own SESSION_SIGNING_KEY. We don't verify locally — the
// admin API verifies on every call. We just decode the payload for userId context.
async function authenticateRequest(request: Request, env: Env): Promise<{ userId?: string; token?: string }> {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return {};
  let token = auth.slice(7).trim();
  if (!token) return {};

  // Resolve OAuth access token -> underlying FGS admin session
  if (env.OAUTH_KV) {
    const fgsSession = await resolveOAuthToken(token, env.OAUTH_KV);
    if (fgsSession) token = fgsSession;
  }

  return { userId: decodeUid(token), token };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // OAuth 2.1 routes (discovery, registration, authorize, token)
    if (env.OAUTH_KV && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
      const oauthRes = await handleOAuthRoute(request, {
        issuer: `${url.protocol}//${url.host}`,
        adminBase: env.API_BASE,
        kv: env.OAUTH_KV,
        githubClientId: env.GITHUB_CLIENT_ID,
        githubClientSecret: env.GITHUB_CLIENT_SECRET,
      });
      if (oauthRes) return oauthRes;
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "FreeGameStore MCP Server\n\n" +
          "Connect: npx mcp-remote https://mcp.freegamestore.online/mcp\n\n" +
          "Build it yourself (your model writes the code): create_game, update_files, read_file, list_files\n" +
          "Let the platform agent build it (you just prompt): agent_build, agent_status\n" +
          "Info: list_games, deploy_status, game_info, game_quality, leaderboard, platform_guide, sdk_reference\n\n" +
          "Two ways to build, both from your editor:\n" +
          "  1. create_game -> read_file/update_files to improve -> deploy_status.\n" +
          "  2. agent_build('make a X game and deploy it') -> the VibeCode agent writes + ships it -> agent_status.\n\n" +
          "Auth: OAuth 2.1 (automatic via mcp-remote) or Bearer <FGS admin session token>.\n",
        { headers: { "content-type": "text/plain" } }
      );
    }

    // Authenticate and inject the session into the target MCP DO before dispatch.
    if (url.pathname.startsWith("/mcp")) {
      const auth = await authenticateRequest(request, env);
      // No token + OAuth configured → return a 401 challenge so mcp-remote starts
      // the browser sign-in flow (like PAGS). The MCP stays closed without auth.
      const oauthConfigured = !!(env.OAUTH_KV && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
      if (!auth.token && oauthConfigured) {
        return unauthorizedChallenge(`${url.protocol}//${url.host}`);
      }
      const sessionId = request.headers.get("mcp-session-id");
      if (auth.token && sessionId) {
        try {
          const id = env.MCP_OBJECT.idFromName(`streamable-http:${sessionId}`);
          const stub = env.MCP_OBJECT.get(id) as unknown as { setAuth(p: McpProps): Promise<void> };
          await stub.setAuth({ userId: auth.userId, token: auth.token });
        } catch {
          /* best effort */
        }
      }
      return FgsMcpAgent.serve("/mcp").fetch(request, env, ctx);
    }

    return FgsMcpAgent.serve("/mcp").fetch(request, env, ctx);
  },
};
