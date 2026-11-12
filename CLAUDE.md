@AGENTS.md

## Claude Code notes

- Graphify MCP tools (`mcp__graphify__*`) are deferred: load them with ToolSearch (e.g. `select:mcp__graphify__query_graph,mcp__graphify__graphify_rank_files`) before the first code investigation in a session.
- Context7 tools are deferred too: load them with `select:mcp__Context7__resolve-library-id,mcp__Context7__get-library-docs` when AGENTS.md calls for a docs lookup.
- `.claude/launch.json` is tracked in git (the rest of `.claude/` is ignored), so every worktree has the `dev` run-server config on port 3000; start it with `preview_start {name: "dev"}`. Only one worktree can serve on 3000 at a time: stop another worktree's server first, or use a different port locally without committing it.
- After UI changes, start the dev server so the user can check the result live (real vault, read-only; see AGENTS.md). To preview a style without saving it, dispatch the `bladevault-settings-change` window event with `{ themeStyle, theme }` instead of changing settings.
- CSS modules: attribute-only selectors must be prefixed with `.root` (e.g. `.root[data-theme-variant='forge'] .cell`).
