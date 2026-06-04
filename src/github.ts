// GitHub Git Data API helpers for the write tools: fetch a template's files,
// push a set of files as one commit, read files back, and read the platform
// registry. All via plain fetch (no deps). Text files are base64-(de)coded
// UTF-8 safe; binary passes through. Vendored from freeappstore-online/mcp.

const UA = "freegamestore-mcp";
const TEXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|html|css|md|txt|svg|yml|yaml|toml)$/i;

async function gh(token: string | undefined, url: string, method = "GET", body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) json.__status = res.status;
  return json;
}

// UTF-8-safe base64 (atob/btoa are latin1-only).
function b64ToText(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function textToB64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export interface RepoFile {
  content: string; // base64
  encoding: "base64";
}

/** Fetch every file of a template repo, substituting APPNAME → gameId in text
 *  files (matches `fgs init`). Returns path → base64 content. */
export async function fetchTemplateFiles(
  org: string,
  templateRepo: string,
  token: string,
  gameId: string,
): Promise<Map<string, RepoFile>> {
  const base = `https://api.github.com/repos/${org}/${templateRepo}`;
  const ref = await gh(token, `${base}/git/ref/heads/main`);
  const headSha = ref?.object?.sha;
  if (!headSha) throw new Error(`template ${templateRepo}: no main ref (${ref.message ?? ref.__status})`);
  const tree = await gh(token, `${base}/git/trees/${headSha}?recursive=1`);
  if (!Array.isArray(tree?.tree)) throw new Error(`template tree fetch failed (${tree.message ?? tree.__status})`);

  const files = new Map<string, RepoFile>();
  for (const item of tree.tree) {
    // Exclude the .git/ directory ONLY — with the trailing slash. A loose
    // ".git" prefix would also drop ".github/workflows/deploy.yml" (because
    // ".github".startsWith(".git") is true), leaving the game with no deploy
    // workflow → it 404s. Keep the slash.
    if (item.type !== "blob" || item.path.startsWith(".git/")) continue;
    const blob = await gh(token, `${base}/git/blobs/${item.sha}`);
    if (typeof blob?.content !== "string") throw new Error(`blob ${item.path} fetch failed`);
    if (TEXT_RE.test(item.path)) {
      const text = b64ToText(blob.content).replaceAll("APPNAME", gameId);
      files.set(item.path, { content: textToB64(text), encoding: "base64" });
    } else {
      files.set(item.path, { content: blob.content.replace(/\n/g, ""), encoding: "base64" });
    }
  }
  if (files.size === 0) throw new Error("template has no files");
  return files;
}

/** Push a set of files to org/repo's main branch as one commit. Handles both an
 *  empty repo (seeds it) and an existing one. With `replaceTree` false (default)
 *  it preserves untouched files via base_tree — the improve loop (update_files).
 *  With `replaceTree` true it omits base_tree, so the commit's tree contains ONLY
 *  the provided files — used by the initial scaffold so a chosen template (grid/
 *  cards/3d) doesn't inherit leftover files from the admin's canvas generate.
 *  Returns the new commit sha. */
export async function pushFiles(
  org: string,
  repo: string,
  token: string,
  files: Map<string, RepoFile>,
  message: string,
  replaceTree = false,
): Promise<string> {
  const base = `https://api.github.com/repos/${org}/${repo}`;

  let parentSha: string | undefined;
  let baseTree: string | undefined;
  const ref = await gh(token, `${base}/git/ref/heads/main`);
  if (ref?.object?.sha) {
    parentSha = ref.object.sha;
    const parent = await gh(token, `${base}/git/commits/${parentSha}`);
    baseTree = parent?.tree?.sha;
  } else {
    // Empty repo — Git Data API needs a commit to exist. Seed via Contents API.
    const seed = await gh(token, `${base}/contents/.gitkeep`, "PUT", {
      message: "seed",
      content: textToB64(""),
    });
    if (!seed?.commit?.sha) throw new Error(`repo seed failed: ${seed.message ?? seed.__status}`);
    parentSha = seed.commit.sha;
    const parent = await gh(token, `${base}/git/commits/${parentSha}`);
    baseTree = parent?.tree?.sha;
  }

  const treeItems: Array<{ path: string; mode: string; type: string; sha: string | null }> = [];
  for (const [path, f] of files) {
    const blob = await gh(token, `${base}/git/blobs`, "POST", { content: f.content, encoding: f.encoding });
    if (!blob?.sha) throw new Error(`blob create failed for ${path}: ${blob.message ?? blob.__status}`);
    treeItems.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }

  // Create the tree, retrying on transient failure. Right after a template
  // `generate` (the admin's provision), the new repo's git data takes ~10-20s to
  // materialize — create-tree 404s in that window even though the blobs above
  // succeeded. The blobs are created once; only the tree create is retried.
  // replaceTree: also stage `sha: null` deletions for every existing path not in
  // `files`, so the result is exactly `files` (a grid/cards/3d game doesn't
  // inherit leftovers from the admin's canvas generate). base_tree is kept —
  // omitting it makes create-tree 404 against the just-made blobs.
  let tree: any;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 3000));
    const items = [...treeItems];
    if (replaceTree && baseTree) {
      const existing = await gh(token, `${base}/git/trees/${baseTree}?recursive=1`);
      if (Array.isArray(existing?.tree)) {
        for (const item of existing.tree) {
          if (item.type === "blob" && !files.has(item.path)) {
            items.push({ path: item.path, mode: "100644", type: "blob", sha: null });
          }
        }
      }
    }
    tree = await gh(token, `${base}/git/trees`, "POST", { base_tree: baseTree, tree: items });
    if (tree?.sha) break;
  }
  if (!tree?.sha) throw new Error(`tree create failed: ${tree?.message ?? tree?.__status}`);

  const commit = await gh(token, `${base}/git/commits`, "POST", {
    message,
    tree: tree.sha,
    parents: parentSha ? [parentSha] : [],
  });
  if (!commit?.sha) throw new Error(`commit create failed: ${commit.message ?? commit.__status}`);

  const upd = await gh(token, `${base}/git/refs/heads/main`, "PATCH", { sha: commit.sha });
  if (!upd?.ref) throw new Error(`ref update failed: ${upd.message ?? upd.__status}`);
  return commit.sha;
}

/** List file paths in a repo (recursive). Read-only; works on public repos. */
export async function listRepoFiles(org: string, repo: string, token?: string): Promise<string[]> {
  const base = `https://api.github.com/repos/${org}/${repo}`;
  const ref = await gh(token, `${base}/git/ref/heads/main`);
  const headSha = ref?.object?.sha;
  if (!headSha) return [];
  const tree = await gh(token, `${base}/git/trees/${headSha}?recursive=1`);
  if (!Array.isArray(tree?.tree)) return [];
  return tree.tree.filter((i: any) => i.type === "blob" && !i.path.startsWith(".git/")).map((i: any) => i.path);
}

/** Read one file's text content from a repo. */
export async function readRepoFile(org: string, repo: string, token: string | undefined, path: string): Promise<string | null> {
  const base = `https://api.github.com/repos/${org}/${repo}`;
  const res = await gh(token, `${base}/contents/${path.split("/").map(encodeURIComponent).join("/")}`);
  if (typeof res?.content !== "string") return null;
  return b64ToText(res.content);
}

export interface RegistryGame {
  id: string;
  name?: string;
  category?: string;
  oneliner?: string;
  description?: string;
  type?: string;
  appUrl?: string;
  repo?: string;
  creatorGithub?: string;
}

/** Read the platform registry (freegamestore-online/<storeRepo>/registry.json)
 *  and return its games list. FGS has no /v1/apps/mine endpoint — registry.json
 *  (with per-game `creatorGithub`) is the ownership source of record. */
export async function readRegistryGames(org: string, storeRepo: string, token?: string): Promise<RegistryGame[]> {
  const raw = await readRepoFile(org, storeRepo, token, "registry.json");
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as { games?: RegistryGame[] } | RegistryGame[];
    if (Array.isArray(data)) return data;
    return data.games ?? [];
  } catch {
    return [];
  }
}

export { textToB64, b64ToText };
