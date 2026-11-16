const { execFileSync } = require('child_process')

// Writes the body of a GitHub release (run from .github/workflows/release.yml).
// Commits since the previous tag are grouped by their pull request's label,
// and each line uses the PR's "Release note" sentence when it has one. When
// GitHub cannot be reached, the notes fall back to a flat list of commit
// titles so a release is never blocked by its notes.
//
// Usage: node scripts/release-notes.cjs <previous-tag|""> <tag>

const DEFAULT_REPOSITORY = 'dedkola/bladevault'
const VERSION_BUMP = /^v?\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/
const PR_SUFFIX = /\s+\(#(\d+)\)$/
const RELEASE_NOTE_HEADING = /^##\s+Release note\s*$/im
const NEXT_HEADING = /^##\s/m

const SECTIONS = [
  { key: 'new', title: 'New' },
  { key: 'improved', title: 'Improved' },
  { key: 'fixed', title: 'Fixed' },
  { key: 'other', title: 'Other changes' },
]

// First match wins, so "internal" hides a PR even when it has other labels.
const LABEL_SECTIONS = [
  ['internal', 'internal'],
  ['dependencies', 'internal'],
  ['feature', 'new'],
  ['bug', 'fixed'],
  ['enhancement', 'improved'],
  ['ui/ux', 'improved'],
  ['qol', 'improved'],
  ['documentation', 'internal'],
]

const BOT_AUTHORS = new Set(['dependabot[bot]', 'dependabot'])

// Reads `git log --format=%s%x09%H%x09%h` output, dropping version bumps.
function parseCommits(log) {
  return String(log || '')
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([subject, sha]) => subject && sha)
    .map(([subject, sha, shortSha]) => {
      const title = subject.trim()
      const match = PR_SUFFIX.exec(title)
      return {
        subject: match ? title.replace(PR_SUFFIX, '') : title,
        sha,
        shortSha: shortSha || sha.slice(0, 7),
        pr: match ? Number(match[1]) : null,
      }
    })
    .filter((commit) => !VERSION_BUMP.test(commit.subject))
}

// The "## Release note" section of a PR body: { text } for a sentence,
// { none: true } for "none", or null when the section is missing or empty.
function readReleaseNote(body) {
  if (typeof body !== 'string') return null
  const heading = RELEASE_NOTE_HEADING.exec(body)
  if (!heading) return null
  let section = body.slice(heading.index + heading[0].length)
  const next = NEXT_HEADING.exec(section)
  if (next) section = section.slice(0, next.index)
  const text = section
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  if (/^none\.?$/i.test(text)) return { none: true }
  return { text }
}

function sectionFor(pull) {
  if (!pull) return 'other'
  if (BOT_AUTHORS.has(pull.author)) return 'internal'
  const labels = new Set(
    (pull.labels || []).map((label) => String(label).toLowerCase()),
  )
  for (const [label, section] of LABEL_SECTIONS) {
    if (labels.has(label)) return section
  }
  return 'other'
}

function bulletList(entries) {
  return entries.map((entry) => `- ${entry}`).join('\n')
}

function downloadsSection({ repository, tag, macReleaseKind }) {
  const base = `https://github.com/${repository}/releases/download/${tag}`
  const file = (name) => `[${name}](${base}/${name})`
  const docs = `https://github.com/${repository}/blob/main/docs/installation/desktop.md`
  const warned =
    macReleaseKind === 'signed' ? 'Windows may' : 'macOS and Windows may'
  return [
    '## Downloads',
    '',
    '| Platform | File |',
    '| --- | --- |',
    `| macOS 13 or newer | ${file('BladeVault.dmg')} |`,
    `| Windows | ${file('BladeVault-Setup.exe')} |`,
    `| Linux (x86-64) | ${file('BladeVault.AppImage')} or ${file('BladeVault.deb')} |`,
    '',
    'Already using the desktop app? Open **Settings → About** to download this update. The Debian package updates by installing the new `.deb` over the old one.',
    '',
    `${warned} warn the first time you open an unsigned build; the [install guide](${docs}) shows how to open it. The \`.zip\`, \`.blockmap\` and \`latest*.yml\` files are for the in-app updater, so you don't need to download them.`,
  ].join('\n')
}

// pulls: Map of PR number → { labels, body, author }, or null when GitHub
// could not be reached (falls back to a flat list of commit titles).
function buildReleaseNotes({
  repository = DEFAULT_REPOSITORY,
  previousTag = '',
  tag,
  commits,
  pulls,
  macReleaseKind = 'unsigned',
}) {
  const prLink = (number) =>
    `[#${number}](https://github.com/${repository}/pull/${number})`
  const commitLink = (commit) =>
    `[${commit.shortSha}](https://github.com/${repository}/commit/${commit.sha})`

  const grouped = new Map(
    [...SECTIONS.map((s) => s.key), 'internal'].map((key) => [key, []]),
  )
  const seenPulls = new Set()
  for (const commit of commits) {
    if (commit.pr === null) {
      grouped.get('internal').push(`${commit.subject} (${commitLink(commit)})`)
      continue
    }
    if (seenPulls.has(commit.pr)) continue
    seenPulls.add(commit.pr)
    if (!pulls) {
      grouped.get('other').push(`${commit.subject} (${prLink(commit.pr)})`)
      continue
    }
    const pull = pulls.get(commit.pr)
    const note = readReleaseNote(pull && pull.body)
    const section = note && note.none ? 'internal' : sectionFor(pull)
    const text = note && note.text ? note.text : commit.subject
    grouped.get(section).push(`${text} (${prLink(commit.pr)})`)
  }

  const parts = []
  const userSections = SECTIONS.filter(
    (section) => grouped.get(section.key).length > 0,
  )
  if (!pulls) {
    // Without labels everything lands in "other": show it as one list.
    const entries = [...grouped.get('other'), ...grouped.get('internal')]
    parts.push(
      "## What's changed",
      '',
      entries.length > 0
        ? bulletList(entries)
        : '- No changes were found for this release.',
    )
  } else {
    parts.push("## What's changed")
    // A lone "Other changes" heading adds nothing when no PR is labeled.
    const onlyOther =
      userSections.length === 1 && userSections[0].key === 'other'
    for (const section of userSections) {
      if (onlyOther) {
        parts.push('', bulletList(grouped.get(section.key)))
        continue
      }
      parts.push(
        '',
        `### ${section.title}`,
        '',
        bulletList(grouped.get(section.key)),
      )
    }
    const internal = grouped.get('internal')
    if (internal.length > 0) {
      parts.push(
        '',
        '<details>',
        `<summary>Under the hood (${internal.length})</summary>`,
        '',
        bulletList(internal),
        '',
        '</details>',
      )
    }
    if (userSections.length === 0 && internal.length === 0) {
      parts.push('', '- No changes were found for this release.')
    }
  }

  parts.push('', downloadsSection({ repository, tag, macReleaseKind }))

  if (previousTag) {
    parts.push(
      '',
      `**Full changelog:** [${previousTag}...${tag}](https://github.com/${repository}/compare/${previousTag}...${tag})`,
    )
  }
  return `${parts.join('\n')}\n`
}

function run(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function fetchPulls(repository, numbers) {
  const pulls = new Map()
  for (const number of numbers) {
    const json = run('gh', [
      'api',
      `repos/${repository}/pulls/${number}`,
      '--jq',
      '{body: .body, author: .user.login, labels: [.labels[].name]}',
    ])
    pulls.set(number, JSON.parse(json))
  }
  return pulls
}

function main(argv) {
  const [previousTag = '', tag] = argv
  if (!tag) {
    throw new Error(
      'Usage: node scripts/release-notes.cjs <previous-tag|""> <tag>',
    )
  }
  const repository =
    process.env.REPOSITORY ||
    process.env.GITHUB_REPOSITORY ||
    DEFAULT_REPOSITORY
  const range = previousTag ? `${previousTag}..${tag}` : tag
  const commits = parseCommits(
    run('git', [
      'log',
      range,
      '--reverse',
      '--no-merges',
      '--format=%s%x09%H%x09%h',
    ]),
  )
  const numbers = [
    ...new Set(commits.map((c) => c.pr).filter((n) => n !== null)),
  ]
  let pulls = null
  try {
    pulls = fetchPulls(repository, numbers)
  } catch (error) {
    console.error(
      `::warning::Could not read pull requests, using commit titles: ${error.message.split('\n')[0]}`,
    )
  }
  process.stdout.write(
    buildReleaseNotes({
      repository,
      previousTag,
      tag,
      commits,
      pulls,
      macReleaseKind: process.env.MAC_RELEASE_KIND,
    }),
  )
}

module.exports = {
  buildReleaseNotes,
  parseCommits,
  readReleaseNote,
  sectionFor,
}

if (require.main === module) {
  main(process.argv.slice(2))
}
