const { execFileSync } = require('child_process')

// Builds the short "What's new" list the desktop app shows after an update.
// It runs at build time (from electron-builder.config.cjs) and reads the
// commit titles since the previous release tag. Only features and fixes are
// listed; chores, docs, CI, tests, and version bumps are left out.

const MAX_ITEMS = 5
const INCLUDED_TYPES = new Map([
  ['feat', 0],
  ['fix', 1],
  ['perf', 1],
])
const CONVENTIONAL = /^(\w+)(?:\([^)]*\))?(!)?:\s*(.+)$/
const PR_SUFFIX = /\s*\(#\d+\)$/
const VERSION_BUMP = /^v?\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/

// Turns one commit title into a list item, or null when it is not shown.
function toHighlight(subject) {
  if (typeof subject !== 'string') return null
  const title = subject.trim()
  if (!title || VERSION_BUMP.test(title) || title.startsWith('Merge ')) {
    return null
  }
  const match = CONVENTIONAL.exec(title)
  if (!match) return null
  const type = match[1].toLowerCase()
  if (!INCLUDED_TYPES.has(type)) return null
  const text = match[3].replace(PR_SUFFIX, '').trim()
  if (!text) return null
  return {
    rank: INCLUDED_TYPES.get(type),
    text: text.charAt(0).toUpperCase() + text.slice(1),
  }
}

// Features first, then fixes, each in commit order, at most MAX_ITEMS.
function buildReleaseHighlights(subjects, limit = MAX_ITEMS) {
  const seen = new Set()
  const highlights = []
  subjects.forEach((subject, index) => {
    const item = toHighlight(subject)
    if (!item || seen.has(item.text.toLowerCase())) return
    seen.add(item.text.toLowerCase())
    highlights.push({ ...item, index })
  })
  highlights.sort((a, b) => a.rank - b.rank || a.index - b.index)
  return {
    items: highlights.slice(0, limit).map((item) => item.text),
    moreCount: Math.max(0, highlights.length - limit),
  }
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

// Reads commit titles since the previous tag. Returns null when the history
// or tags are missing (for example a shallow clone), so no list is shipped.
function readReleaseHighlights(cwd = process.cwd()) {
  try {
    const previousTag = git(['describe', '--tags', '--abbrev=0', 'HEAD^'], cwd)
    const log = git(
      [
        'log',
        `${previousTag}..HEAD`,
        '--reverse',
        '--no-merges',
        '--format=%s',
      ],
      cwd,
    )
    const result = buildReleaseHighlights(log ? log.split('\n') : [])
    return result.items.length > 0 ? result : null
  } catch {
    return null
  }
}

module.exports = { MAX_ITEMS, buildReleaseHighlights, readReleaseHighlights }

if (require.main === module) {
  console.log(JSON.stringify(readReleaseHighlights(), null, 2))
}
