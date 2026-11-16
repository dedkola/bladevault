import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const loadCommonJs = createRequire(import.meta.url)
const { buildReleaseNotes, parseCommits, readReleaseNote } = loadCommonJs(
  '../../scripts/release-notes.cjs',
)

const LOG = [
  'Add the Shelf style (#530)\taaaaaaaaaa\taaaaaaa',
  'Fix arrow-key issues (#539)\tbbbbbbbbbb\tbbbbbbb',
  'Remove dead exports (#535)\tcccccccccc\tccccccc',
  'Delete .codex directory\tdddddddddd\tddddddd',
  'Tweak footer (#538)\teeeeeeeeee\teeeeeee',
  '2.4.6\tffffffffff\tfffffff',
].join('\n')

const PULLS = new Map([
  [
    530,
    {
      labels: ['feature'],
      body: '## Release note\n\nNew **Shelf** style.\n\n## Why\n\nx',
      author: 'dev',
    },
  ],
  [539, { labels: ['bug', 'ui/ux'], body: null, author: 'dev' }],
  [
    535,
    {
      labels: ['enhancement'],
      body: '## Release note\n\n<!-- hint -->\nnone\n',
      author: 'dev',
    },
  ],
  [538, { labels: [], body: '', author: 'dev' }],
])

function notes(
  pulls: Map<number, unknown> | null,
  macReleaseKind = 'unsigned',
) {
  return buildReleaseNotes({
    repository: 'owner/repo',
    previousTag: 'v1.0.0',
    tag: 'v1.0.1',
    commits: parseCommits(LOG),
    pulls,
    macReleaseKind,
  })
}

describe('release notes', () => {
  it('parses commits and drops version bumps', () => {
    const commits = parseCommits(LOG)
    expect(commits).toHaveLength(5)
    expect(commits[0]).toMatchObject({
      subject: 'Add the Shelf style',
      pr: 530,
    })
    expect(commits[3]).toMatchObject({
      subject: 'Delete .codex directory',
      pr: null,
    })
  })

  it('reads the Release note section', () => {
    expect(
      readReleaseNote('## Release note\n<!-- x -->\n Shows   photos.\n## Why'),
    ).toEqual({
      text: 'Shows photos.',
    })
    expect(readReleaseNote('## Release note\n\nNone.')).toEqual({ none: true })
    expect(
      readReleaseNote('## Release note\n\n<!-- only a hint -->\n'),
    ).toBeNull()
    expect(readReleaseNote('## What changed\n\nStuff')).toBeNull()
    expect(readReleaseNote(null)).toBeNull()
    expect(
      readReleaseNote('## Release note\n<!<!-- x -->-- <b>Bold</b>'),
    ).toEqual({ text: '&lt;!-- &lt;b>Bold&lt;/b>' })
  })

  it('groups pull requests by label and uses release notes', () => {
    const body = notes(PULLS)
    expect(body).toContain(
      '### New\n\n- New **Shelf** style. ([#530](https://github.com/owner/repo/pull/530))',
    )
    expect(body).toContain('### Fixed\n\n- Fix arrow-key issues ([#539]')
    expect(body).toContain('### Other changes\n\n- Tweak footer ([#538]')
    expect(body).not.toContain('### Improved')
    expect(body).toContain('<summary>Under the hood (2)</summary>')
    expect(body).toContain('- Remove dead exports ([#535]')
    expect(body).toContain(
      '- Delete .codex directory ([ddddddd](https://github.com/owner/repo/commit/dddddddddd))',
    )
    expect(body).toContain(
      '**Full changelog:** [v1.0.0...v1.0.1](https://github.com/owner/repo/compare/v1.0.0...v1.0.1)',
    )
  })

  it('puts dependency bot updates under the hood', () => {
    const pulls = new Map(PULLS)
    pulls.set(538, { labels: [], body: '', author: 'dependabot[bot]' })
    expect(notes(pulls)).toContain('<summary>Under the hood (3)</summary>')
  })

  it('falls back to a flat list without pull request data', () => {
    const body = notes(null)
    expect(body).not.toContain('###')
    expect(body).toContain('- Add the Shelf style ([#530]')
    expect(body).toContain('- Delete .codex directory ([ddddddd]')
  })

  it('links downloads for the tag and mentions unsigned builds', () => {
    const body = notes(PULLS)
    expect(body).toContain(
      '[BladeVault.dmg](https://github.com/owner/repo/releases/download/v1.0.1/BladeVault.dmg)',
    )
    expect(body).toContain('macOS and Windows may warn')
    expect(notes(PULLS, 'signed')).toContain('Windows may warn')
    expect(notes(PULLS, 'signed')).not.toContain('macOS and Windows')
  })
})
