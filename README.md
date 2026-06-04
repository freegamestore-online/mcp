# freegamestore-mcp

Remote MCP server for **FreeGameStore** — build, publish, and improve PWA games
from your editor (Cursor, Claude, Claude Code, …).

```
claude mcp add freegamestore -- npx mcp-remote https://mcp.freegamestore.online/mcp
```

Two ways to build, both from the editor:

1. **Your model writes the code, the MCP ships it** — `create_game` scaffolds + provisions a live game, then `update_files` improves it (auto-deploys to `<id>.freegamestore.online`).
2. **The platform's VibeCode agent writes + deploys it, you just prompt** — `agent_build('make a tetris clone and deploy it as my-tetris')`, then `agent_status`.

Tools: `create_game`, `update_files`, `read_file`, `list_files`, `agent_build`,
`agent_status`, `list_games`, `deploy_status`, `game_info`, `game_logs`,
`platform_guide`, `sdk_reference`.

Authenticated tools take an FGS session token: `Authorization: Bearer <token>`.
`mcp-remote` handles the OAuth/token handoff.

Cloudflare Worker (`agents` McpAgent, Streamable HTTP). See `CLAUDE.md` for
architecture, secrets, and the gotchas. MIT.
