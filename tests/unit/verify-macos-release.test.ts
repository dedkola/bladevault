import { readFileSync } from 'node:fs'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(
  new URL('../../scripts/verify-macos-release.cjs', import.meta.url),
  'utf8',
)
const appPath = '/work/dist/desktop/mac-arm64/BladeVault.app'
const unsignedResult = {
  status: 1,
  stderr: `${appPath}: code object is not signed at all\n`,
}

type CommandResult = {
  status: number | null
  stdout?: string
  stderr?: string
  error?: Error
}

function verify(signed: boolean, results: CommandResult[]) {
  const spawnSync = vi.fn(() => results.shift() ?? { status: 0 })
  const exit = vi.fn()
  const log = vi.fn()
  const error = vi.fn()

  runInNewContext(source, {
    require(name: string) {
      if (name === 'child_process') return { spawnSync }
      if (name === 'path') return path
      if (name === 'fs') {
        return {
          existsSync: () => true,
          readdirSync: () => [{ name: 'mac-arm64', isDirectory: () => true }],
        }
      }
      throw new Error(`Unexpected module: ${name}`)
    },
    process: {
      platform: 'darwin',
      cwd: () => '/work',
      env: { BLADEVAULT_MAC_SIGN: signed ? '1' : '0' },
      exit,
    },
    console: { log, error },
  })

  return { spawnSync, exit, log, error }
}

describe('macOS release verification', () => {
  it('accepts a completely unsigned tester build', () => {
    const result = verify(false, [unsignedResult])

    expect(result.exit).not.toHaveBeenCalled()
    expect(result.log).toHaveBeenCalledWith('Unsigned tester build detected.')
    expect(result.spawnSync).toHaveBeenCalledTimes(1)
  })

  it('accepts ad-hoc signing metadata for a tester build', () => {
    const result = verify(false, [{ status: 0, stderr: 'Signature=adhoc' }])

    expect(result.exit).not.toHaveBeenCalled()
    expect(result.log).toHaveBeenCalledWith('Signature=adhoc')
    expect(result.spawnSync).toHaveBeenCalledTimes(1)
  })

  it('rejects unrelated inspection failures for tester builds', () => {
    const result = verify(false, [
      { status: 1, stderr: 'invalid bundle format' },
    ])

    expect(result.exit).toHaveBeenCalledWith(1)
    expect(result.error).toHaveBeenCalledWith(
      expect.stringContaining('invalid bundle format'),
    )
    expect(result.log).not.toHaveBeenCalledWith(
      'Unsigned tester build detected.',
    )
  })

  it('rejects failures to launch codesign', () => {
    const result = verify(false, [
      { status: null, error: new Error('spawn codesign ENOENT') },
    ])

    expect(result.exit).toHaveBeenCalledWith(1)
    expect(result.error).toHaveBeenCalledWith(
      expect.stringContaining('spawn codesign ENOENT'),
    )
  })

  it('rejects an unsigned app when signing is required', () => {
    const result = verify(true, [unsignedResult])

    expect(result.exit).toHaveBeenCalledWith(1)
    expect(result.spawnSync).toHaveBeenCalledTimes(1)
  })

  it('checks signature integrity and Gatekeeper for signed releases', () => {
    const result = verify(true, [
      { status: 0, stderr: 'Authority=Developer ID Application' },
      { status: 0 },
      { status: 0, stderr: 'accepted' },
    ])

    expect(result.exit).not.toHaveBeenCalled()
    expect(result.spawnSync.mock.calls.map((call) => call.slice(0, 2))).toEqual(
      [
        ['codesign', ['-dv', '--verbose=4', appPath]],
        [
          'codesign',
          ['--verify', '--deep', '--strict', '--verbose=4', appPath],
        ],
        ['spctl', ['-a', '-vv', appPath]],
      ],
    )
  })

  it('rejects a broken signed release before assessing Gatekeeper', () => {
    const result = verify(true, [
      { status: 0 },
      { status: 1, stderr: 'a sealed resource is missing or invalid' },
    ])

    expect(result.exit).toHaveBeenCalledWith(1)
    expect(result.spawnSync).toHaveBeenCalledTimes(2)
  })

  it('rejects a signed release rejected by Gatekeeper', () => {
    const result = verify(true, [
      { status: 0 },
      { status: 0 },
      { status: 3, stderr: 'rejected' },
    ])

    expect(result.exit).toHaveBeenCalledWith(1)
    expect(result.error).toHaveBeenCalledWith(
      expect.stringContaining('rejected'),
    )
  })
})
