import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireVaultRestore,
  assertVaultGeneration,
  getVaultAccessState,
  getVaultControlDir,
  getVaultGeneration,
  vaultAccessErrorResponse,
  VaultAccessError,
  withVaultWrite,
  withVaultWriteSync,
  type VaultRestoreLease,
} from '@/lib/vault-access'
import { getLocalDb } from '@/lib/local-db'
import { getLocalRestoreJournalPath } from '@/lib/local-restore-recovery'
import {
  captureAppLockAccessSnapshot,
  createAppUnlockToken,
  requireAppUnlock,
  setAppLockPassword,
} from '@/lib/app-lock'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault
let leases: VaultRestoreLease[]
let children: ChildProcess[]
let temporaryDirectories: string[]

beforeEach(async () => {
  vault = await createTempVault('bladevault-access-')
  leases = []
  children = []
  temporaryDirectories = []
})

afterEach(async () => {
  for (const lease of leases) lease.release()
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
  }
  await vault.cleanup()
  for (const directory of temporaryDirectories)
    await fs.rm(directory, { recursive: true, force: true })
})

function startRestore() {
  const lease = acquireVaultRestore()
  leases.push(lease)
  return lease
}

function waitForOutput(child: ChildProcess, expected: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    let errors = ''
    const timeout = setTimeout(
      () => reject(new Error(`Missing ${expected}: ${errors}`)),
      5000,
    )
    child.stderr!.on('data', (chunk) => {
      errors += String(chunk)
    })
    const read = (chunk: Buffer) => {
      output += String(chunk)
      if (!output.includes(expected)) return
      clearTimeout(timeout)
      child.stdout!.off('data', read)
      resolve(output)
    }
    child.stdout!.on('data', read)
    child.once('error', reject)
    child.once('exit', () => {
      clearTimeout(timeout)
      if (!output.includes(expected))
        reject(new Error(errors || `Child exited before ${expected}.`))
    })
  })
}

describe('vault restore access', () => {
  it('keeps preparation readable, rejects new writes, and changes generation only on success', async () => {
    const database = getLocalDb()
    const generation = getVaultGeneration()
    const lease = startRestore()
    expect(getVaultAccessState()).toMatchObject({
      generation,
      phase: 'preparing',
      readOnly: true,
    })
    expect(getLocalDb()).toBe(database)
    expect(() => withVaultWriteSync(() => 'unexpected')).toThrow(
      VaultAccessError,
    )
    await expect(
      withVaultWrite(async () => 'unexpected'),
    ).rejects.toMatchObject({
      code: 'VAULT_RESTORE_BUSY',
      status: 423,
    })
    lease.finish(false)
    expect(getVaultGeneration()).toBe(generation)
    const success = startRestore()
    await success.beginSwitch()
    expect(database.open).toBe(false)
    expect(() => getLocalDb()).toThrow(VaultAccessError)
    success.finish(true)
    expect(getVaultAccessState().phase).toBe('idle')
    expect(getVaultGeneration()).not.toBe(generation)
    expect(() => assertVaultGeneration(generation)).toThrow(VaultAccessError)
    expect(getLocalDb()).not.toBe(database)
  })

  it('drains an existing async writer and permits nested writes while rejecting new writers', async () => {
    getLocalDb()
    let complete!: () => void
    const gate = new Promise<void>((resolve) => {
      complete = resolve
    })
    let nestedCompleted = false
    const writer = withVaultWrite(async () => {
      await gate
      await withVaultWrite(async () => {
        withVaultWriteSync(() => {
          getLocalDb()
            .prepare('INSERT INTO settings(key,value) VALUES (?,?)')
            .run('nested', 'saved')
          nestedCompleted = true
        })
      })
    })
    const lease = startRestore()
    let drained = false
    const drain = lease.waitForWriters().then(() => {
      drained = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(drained).toBe(false)
    expect(() => withVaultWriteSync(() => 'unexpected')).toThrow(
      VaultAccessError,
    )
    complete()
    await writer
    await drain
    expect(nestedCompleted).toBe(true)
    expect(drained).toBe(true)
  })

  it('returns a typed retry response and authenticates the captured session during switching', async () => {
    setAppLockPassword('secret')
    const token = createAppUnlockToken()
    captureAppLockAccessSnapshot()
    const lease = startRestore()
    await lease.beginSwitch()
    const request = new Request('http://localhost/api/vault/status', {
      headers: { cookie: `bladevault_unlock=${token}` },
    })
    expect(requireAppUnlock(request)).toBeNull()
    expect(requireAppUnlock(new Request(request.url))?.status).toBe(401)
    let failure: unknown
    try {
      getLocalDb()
    } catch (error) {
      failure = error
    }
    const response = vaultAccessErrorResponse(failure)!
    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('1')
    await expect(response.json()).resolves.toMatchObject({
      code: 'VAULT_RESTORE_BUSY',
      vault: { phase: 'switching', readOnly: true },
    })
  })

  it('recovers dead preparation owners and ignores old repeated releases', async () => {
    getVaultGeneration()
    await fs.writeFile(
      path.join(getVaultControlDir(), 'restore.json'),
      JSON.stringify({
        pid: 2147483647,
        token: 'dead-owner',
        phase: 'preparing',
      }),
    )
    expect(getVaultAccessState().phase).toBe('idle')
    const first = startRestore()
    first.release()
    const second = startRestore()
    first.release()
    expect(() => acquireVaultRestore()).toThrow(VaultAccessError)
    second.release()
    expect(getVaultAccessState().phase).toBe('idle')
  })

  it('does not reuse an ended writer context inherited by deferred work', async () => {
    let resume!: () => void
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    let detached!: Promise<unknown>
    await withVaultWrite(async () => {
      detached = (async () => {
        await gate
        return withVaultWriteSync(() => 'unexpected')
      })().catch((error: unknown) => error)
    })
    startRestore()
    resume()
    await expect(detached).resolves.toMatchObject({
      code: 'VAULT_RESTORE_BUSY',
    })
  })

  it('recognizes the same PID from an older server process as a stale owner', async () => {
    getVaultGeneration()
    await fs.writeFile(
      path.join(getVaultControlDir(), 'restore.json'),
      JSON.stringify({
        pid: process.pid,
        startedAt: performance.timeOrigin - 1,
        token: 'previous-server',
        phase: 'preparing',
      }),
    )
    expect(getVaultAccessState().phase).toBe('idle')
    const lease = startRestore()
    lease.release()
  })

  it('keeps a failed install protected and reports recovery required while its process is alive', async () => {
    const lease = startRestore()
    await lease.beginSwitch()
    lease.abandon()
    lease.release()
    expect(getVaultAccessState()).toMatchObject({
      phase: 'switching',
      readOnly: true,
      recoveryRequired: true,
    })
    expect(() => getLocalDb()).toThrow('Vault recovery is required')
    expect(() => acquireVaultRestore()).toThrow(VaultAccessError)
  })

  it('recovers an interrupted replacement before publishing an idle generation', async () => {
    const generation = getVaultGeneration()
    const stagingDir = path.join(
      vault.dataDir,
      '._bladevault-restore-stage-interrupted',
    )
    const safetyBackupDir = path.join(
      vault.dataDir,
      '._bladevault-before-restore-interrupted',
    )
    await fs.mkdir(stagingDir)
    await fs.mkdir(safetyBackupDir)
    await fs.writeFile(path.join(vault.dataDir, 'entry.txt'), 'new contents')
    await fs.writeFile(
      path.join(safetyBackupDir, 'entry.txt'),
      'previous contents',
    )
    await fs.writeFile(
      getLocalRestoreJournalPath(vault.dataDir),
      JSON.stringify({
        ownerPid: 2147483647,
        state: 'switching',
        stagingDir,
        safetyBackupDir,
        oldEntries: ['entry.txt'],
        newEntries: ['entry.txt'],
      }),
    )
    await fs.writeFile(
      path.join(getVaultControlDir(), 'restore.json'),
      JSON.stringify({
        pid: 2147483647,
        token: 'interrupted-install',
        phase: 'switching',
      }),
    )
    const state = getVaultAccessState()
    expect(state.phase).toBe('idle')
    expect(state.generation).not.toBe(generation)
    expect(
      await fs.readFile(path.join(vault.dataDir, 'entry.txt'), 'utf8'),
    ).toBe('previous contents')
    await expect(
      fs.access(getLocalRestoreJournalPath(vault.dataDir)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('waits for a separately launched process to close its SQLite connection', async () => {
    getLocalDb()
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'bladevault-reader-'),
    )
    temporaryDirectories.push(temporaryDirectory)
    await fs.symlink(
      path.join(process.cwd(), 'node_modules'),
      path.join(temporaryDirectory, 'node_modules'),
      'junction',
    )
    const scriptPath = path.join(temporaryDirectory, 'reader.mjs')
    await build({
      stdin: {
        contents: `import { getLocalDb } from './lib/local-db';
          const database = getLocalDb();
          process.stdout.write('ready\\n');
          const timer = setInterval(() => {
            if (!database.open) {
              process.stdout.write('closed\\n');
              clearInterval(timer);
            }
          }, 20);`,
        resolveDir: process.cwd(),
        sourcefile: 'vault-reader.ts',
        loader: 'ts',
      },
      outfile: scriptPath,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      tsconfig: path.join(process.cwd(), 'tsconfig.json'),
    })
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, BLADEVAULT_DATA_DIR: vault.dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let output = ''
    let errors = ''
    child.stdout!.on('data', (chunk) => {
      output += String(chunk)
    })
    child.stderr!.on('data', (chunk) => {
      errors += String(chunk)
    })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Reader failed to start: ${errors}`)),
        5000,
      )
      const check = (chunk: Buffer) => {
        if (!String(chunk).includes('ready')) return
        clearTimeout(timeout)
        child.stdout!.off('data', check)
        resolve()
      }
      child.stdout!.on('data', check)
      child.once('error', reject)
      child.once('exit', () => {
        clearTimeout(timeout)
        if (!output.includes('ready'))
          reject(new Error(errors || 'Reader exited before opening SQLite.'))
      })
    })
    const lease = startRestore()
    const exited = once(child, 'exit')
    await lease.beginSwitch({ timeoutMs: 5000 })
    await exited
    expect(output).toContain('closed')
    expect(errors).toBe('')
    lease.finish(true)
  })

  it('does not let a delayed stale-owner observer remove another process new restore lease', async () => {
    getVaultGeneration()
    await fs.writeFile(
      path.join(getVaultControlDir(), 'restore.json'),
      JSON.stringify({
        pid: 2147483647,
        token: 'dead-restore-owner',
        phase: 'preparing',
      }),
    )
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'bladevault-coordination-'),
    )
    temporaryDirectories.push(temporaryDirectory)
    await fs.symlink(
      path.join(process.cwd(), 'node_modules'),
      path.join(temporaryDirectory, 'node_modules'),
      'junction',
    )
    const scriptPath = path.join(temporaryDirectory, 'actor.mjs')
    const barrierPath = path.join(temporaryDirectory, 'continue')
    await build({
      stdin: {
        contents: `import fs from 'node:fs';
          import path from 'node:path';
          import { acquireVaultRestore, getVaultAccessState } from './lib/vault-access';
          if (process.argv[2] === 'observer') {
            const read = fs.readFileSync.bind(fs);
            let delayed = false;
            fs.readFileSync = function(file, ...options) {
              const value = read(file, ...options);
              if (!delayed && String(file) === path.join(process.env.BLADEVAULT_DATA_DIR, '._bladevault-control', 'restore.json')) {
                delayed = true;
                process.stdout.write('captured\\n');
                const gate = new Int32Array(new SharedArrayBuffer(4));
                while (!fs.existsSync(process.env.VAULT_TEST_BARRIER)) Atomics.wait(gate, 0, 0, 10);
              }
              return value;
            };
            process.stdout.write('observed:' + getVaultAccessState().phase + '\\n');
          } else {
            const lease = acquireVaultRestore();
            process.stdout.write('acquired\\n');
            const timer = setInterval(() => {}, 1000);
            process.once('SIGTERM', () => { lease.release(); clearInterval(timer); });
          }`,
        resolveDir: process.cwd(),
        sourcefile: 'vault-coordination-actor.ts',
        loader: 'ts',
      },
      outfile: scriptPath,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      tsconfig: path.join(process.cwd(), 'tsconfig.json'),
    })
    const options: SpawnOptions = {
      env: {
        ...process.env,
        BLADEVAULT_DATA_DIR: vault.dataDir,
        VAULT_TEST_BARRIER: barrierPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
    const observer = spawn(process.execPath, [scriptPath, 'observer'], options)
    children.push(observer)
    await waitForOutput(observer, 'captured')
    const owner = spawn(process.execPath, [scriptPath, 'owner'], options)
    children.push(owner)
    await waitForOutput(owner, 'acquired')
    const observed = waitForOutput(observer, 'observed:preparing')
    await fs.writeFile(barrierPath, '')
    await observed
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(getVaultControlDir(), 'restore.json'),
          'utf8',
        ),
      ).pid,
    ).toBe(owner.pid)
    expect(() => acquireVaultRestore()).toThrow(VaultAccessError)
    expect(() => withVaultWriteSync(() => 'unexpected')).toThrow(
      VaultAccessError,
    )
  })
})
