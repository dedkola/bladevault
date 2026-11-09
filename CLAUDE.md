@AGENTS.md

## Claude Code notes

- Graphify MCP tools (`mcp__graphify__*`) are deferred: load them with ToolSearch (e.g. `select:mcp__graphify__query_graph,mcp__graphify__graphify_rank_files`) before the first code investigation in a session.
- `.claude/` is gitignored, so new worktrees under `.claude/worktrees/` have no `.claude/launch.json` and the app shows no run-server preview. Before UI work in a fresh worktree, create it with a `dev` config running `npm run dev -- -p <port>` on a port no other worktree uses (3217–3219 are taken), then start the preview.
- After UI changes, start the dev server so the user can check the result live (real vault, read-only; see AGENTS.md). To preview a style without saving it, dispatch the `bladevault-settings-change` window event with `{ themeStyle, theme }` instead of changing settings.
- CSS modules: attribute-only selectors must be prefixed with `.root` (e.g. `.root[data-theme-variant='forge'] .cell`).
