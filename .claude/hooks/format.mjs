#!/usr/bin/env node
// PostToolUse hook: format the file Claude just edited with the repo's own Prettier.
// Respects .prettierignore, skips unknown file types, and never blocks the edit.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd()
const prettier = path.join(projectDir, 'node_modules', '.bin', 'prettier')

let filePath
try {
  filePath = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.file_path
} catch {
  process.exit(0)
}

if (!filePath || !existsSync(prettier) || !existsSync(filePath)) process.exit(0)

spawnSync(
  prettier,
  ['--write', '--ignore-unknown', '--log-level', 'warn', filePath],
  { cwd: projectDir, stdio: ['ignore', 'ignore', 'inherit'] },
)
process.exit(0)
