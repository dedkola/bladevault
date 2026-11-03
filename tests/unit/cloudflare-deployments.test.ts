import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const loadCommonJs = createRequire(import.meta.url)
const reportCloudflareDeployments = loadCommonJs(
  '../../.github/scripts/report-cloudflare-deployment.cjs',
) as (options: ReturnType<typeof setup>['options']) => Promise<void>

const commit = 'a'.repeat(40)
const buildId = 'bfdc61ac-4efb-433c-8f09-0fce2aefbe80'
const account = '73026fc18aa364a3cc60305b6c6fb75c'
const productionLog = `https://dash.cloudflare.com/${account}/workers/services/view/bladevault/production/builds/${buildId}`
const previewLog = `https://dash.cloudflare.com/${account}/workers/services/view/bladevault/production/previews/dev-change/builds/${buildId}`

function makeCheck() {
  return {
    id: 100,
    name: 'Workers Builds: bladevault',
    head_sha: commit,
    status: 'completed',
    conclusion: 'success' as string | null,
    external_id: buildId,
    details_url: productionLog,
    completed_at: '2026-11-03T15:05:56Z' as string | null,
    app: { id: 85455, slug: 'cloudflare-workers-and-pages' },
    check_suite: { id: 200 },
  }
}

type Deployment = {
  id: number
  sha: string
  environment: string
  payload: Record<string, unknown>
}

function setup() {
  const check = makeCheck()
  const checks = [check]
  const deployments: Deployment[] = []
  const recent: Deployment[] = []
  const suite = {
    id: 200,
    head_sha: commit,
    head_branch: 'main' as string | null,
    app: { id: 85455, slug: 'cloudflare-workers-and-pages' },
    repository: { full_name: 'dedkola/bladevault' },
  }
  const rest = {
    checks: {
      listForRef: vi.fn(),
      getSuite: vi.fn(async () => ({ data: suite })),
    },
    repos: {
      listDeployments: vi.fn(async () => ({ data: recent })),
      createDeployment: vi.fn(async () => ({
        status: 201,
        data: { id: 300 },
      })),
      listDeploymentStatuses: vi.fn(async () => ({
        data: [] as Record<string, unknown>[],
      })),
      createDeploymentStatus: vi.fn(async () => ({
        status: 201,
        data: { id: 400 },
      })),
    },
  }
  const github = {
    rest,
    paginate: vi.fn(async (method: unknown) => {
      if (method === rest.checks.listForRef) return checks
      if (method === rest.repos.listDeployments) return deployments
      throw new Error('Unexpected paginated API call')
    }),
  }
  const context: {
    repo: { owner: string; repo: string }
    eventName: string
    sha: string
    payload: {
      check_run?: ReturnType<typeof makeCheck>
      repository: { full_name: string; default_branch: string }
      inputs: Record<string, string>
      workflow_run?: {
        head_sha: string
        head_repository: { full_name: string }
      }
    }
  } = {
    repo: { owner: 'dedkola', repo: 'bladevault' },
    eventName: 'check_run',
    sha: 'b'.repeat(40),
    payload: {
      check_run: check,
      repository: {
        full_name: 'dedkola/bladevault',
        default_branch: 'main',
      },
      inputs: {} as Record<string, string>,
    },
  }
  const core = {
    info: vi.fn(),
    warning: vi.fn(),
    debug: vi.fn(),
    setFailed: vi.fn(),
  }
  const sleep = vi.fn(async () => {})
  const options = { github, context, core, sleep }
  return { check, checks, deployments, recent, suite, rest, options }
}

function recordedDeployment(environment = 'Production'): Deployment {
  return {
    id: 123,
    sha: commit,
    environment,
    payload: { source: 'cloudflare-workers-builds', build_id: buildId },
  }
}

describe('Cloudflare deployment reporting', () => {
  it('records production for the exact Cloudflare commit without merging or deploying code', async () => {
    const { options, rest } = setup()

    await reportCloudflareDeployments(options)

    expect(rest.repos.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'dedkola',
        repo: 'bladevault',
        ref: commit,
        environment: 'Production',
        auto_merge: false,
        required_contexts: [],
        production_environment: true,
        transient_environment: false,
        payload: expect.objectContaining({
          source: 'cloudflare-workers-builds',
          build_id: buildId,
        }),
      }),
    )
    expect(rest.repos.createDeploymentStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        deployment_id: 300,
        state: 'success',
        environment_url: 'https://bladevault.tkweb.dev',
        log_url: productionLog,
        auto_inactive: false,
      }),
    )
  })

  it.each([
    ['failure', 'failure'],
    ['cancelled', 'failure'],
    ['action_required', 'failure'],
    ['timed_out', 'error'],
  ])('reports %s as %s instead of success', async (conclusion, state) => {
    const { check, options, rest } = setup()
    check.conclusion = conclusion

    await reportCloudflareDeployments(options)

    expect(rest.repos.createDeploymentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state }),
    )
  })

  it('records an isolated branch preview without deactivating other previews', async () => {
    const { check, suite, options, rest } = setup()
    suite.head_branch = 'dev/change'
    check.details_url = previewLog

    await reportCloudflareDeployments(options)

    expect(rest.repos.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: commit,
        environment: 'Preview',
        production_environment: false,
        transient_environment: true,
      }),
    )
    expect(rest.repos.createDeploymentStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'success',
        environment_url: previewLog,
        log_url: previewLog,
        auto_inactive: false,
      }),
    )
  })

  it.each(['neutral', 'skipped', 'stale'])(
    'does not create a deployment for a %s check',
    async (conclusion) => {
      const { check, options, rest } = setup()
      check.conclusion = conclusion

      await reportCloudflareDeployments(options)

      expect(rest.repos.createDeployment).not.toHaveBeenCalled()
      expect(rest.repos.createDeploymentStatus).not.toHaveBeenCalled()
    },
  )

  it.each(['app', 'worker', 'account'])(
    'ignores results with an untrusted %s identity',
    async (identity) => {
      const { check, options, rest } = setup()
      if (identity === 'app') check.app.id = 1
      if (identity === 'worker') check.name = 'Workers Builds: another-worker'
      if (identity === 'account') {
        check.details_url = productionLog.replace(account, '0'.repeat(32))
      }

      await expect(reportCloudflareDeployments(options)).rejects.toThrow()

      expect(rest.repos.createDeployment).not.toHaveBeenCalled()
      expect(rest.repos.createDeploymentStatus).not.toHaveBeenCalled()
    },
  )

  it.each(['missing branch', 'fork repository'])(
    'does not infer production from %s',
    async (reason) => {
      const { suite, options, rest } = setup()
      if (reason === 'missing branch') suite.head_branch = null
      else suite.repository.full_name = 'someone/bladevault'

      await expect(reportCloudflareDeployments(options)).rejects.toThrow()

      expect(rest.repos.createDeployment).not.toHaveBeenCalled()
      expect(rest.repos.createDeploymentStatus).not.toHaveBeenCalled()
    },
  )

  it('does not accept a production log URL as evidence of a branch preview', async () => {
    const { suite, options, rest } = setup()
    suite.head_branch = 'dev/change'

    await expect(reportCloudflareDeployments(options)).rejects.toThrow()

    expect(rest.repos.createDeployment).not.toHaveBeenCalled()
    expect(rest.repos.createDeploymentStatus).not.toHaveBeenCalled()
  })

  it('reuses an existing Cloudflare build record when status reporting previously failed', async () => {
    const { deployments, options, rest } = setup()
    deployments.push(recordedDeployment())

    await reportCloudflareDeployments(options)

    expect(rest.repos.createDeployment).not.toHaveBeenCalled()
    expect(rest.repos.createDeploymentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ deployment_id: 123, state: 'success' }),
    )
  })

  it('does not duplicate a deployment or unchanged status on repeated delivery', async () => {
    const { deployments, options, rest } = setup()
    deployments.push(recordedDeployment())
    rest.repos.listDeploymentStatuses.mockResolvedValue({
      data: [
        {
          state: 'success',
          environment_url: 'https://bladevault.tkweb.dev',
          log_url: productionLog,
        },
      ],
    })

    await reportCloudflareDeployments(options)

    expect(rest.repos.createDeployment).not.toHaveBeenCalled()
    expect(rest.repos.createDeploymentStatus).not.toHaveBeenCalled()
  })

  it('keeps existing deployments from another provider instead of treating them as Cloudflare reports', async () => {
    const { deployments, options, rest } = setup()
    deployments.push({ ...recordedDeployment(), payload: {} })

    await reportCloudflareDeployments(options)

    expect(rest.repos.createDeployment).toHaveBeenCalledOnce()
    expect(rest.repos.createDeploymentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ deployment_id: 300, auto_inactive: false }),
    )
  })

  it('marks a delayed successful build inactive when its branch has a newer successful build', async () => {
    const { recent, options, rest } = setup()
    recent.push({
      ...recordedDeployment(),
      sha: 'c'.repeat(40),
      payload: {
        source: 'cloudflare-workers-builds',
        build_id: 'ccdc61ac-4efb-433c-8f09-0fce2aefbe80',
        branch: 'main',
        conclusion: 'success',
        completed_at: '2026-11-03T16:00:00Z',
      },
    })

    await reportCloudflareDeployments(options)

    expect(rest.repos.createDeploymentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'inactive', auto_inactive: false }),
    )
  })

  it('propagates deployment API errors without reporting success', async () => {
    const { options, rest } = setup()
    rest.repos.createDeployment.mockRejectedValue(new Error('API unavailable'))

    await expect(reportCloudflareDeployments(options)).rejects.toThrow(
      'API unavailable',
    )

    expect(rest.repos.createDeploymentStatus).not.toHaveBeenCalled()
  })

  it('fails a manual report when no completed Cloudflare build is available', async () => {
    const { checks, options, rest } = setup()
    checks.length = 0
    options.context.eventName = 'workflow_dispatch'
    delete options.context.payload.check_run
    options.context.payload.inputs.commit_sha = commit

    await expect(reportCloudflareDeployments(options)).rejects.toThrow()

    expect(rest.repos.createDeployment).not.toHaveBeenCalled()
    expect(rest.repos.createDeploymentStatus).not.toHaveBeenCalled()
  })

  it('waits for Cloudflare when the Test workflow finishes first', async () => {
    const { check, options, rest } = setup()
    check.status = 'in_progress'
    options.context.eventName = 'workflow_run'
    delete options.context.payload.check_run
    options.context.payload.workflow_run = {
      head_sha: commit,
      head_repository: { full_name: 'dedkola/bladevault' },
    }
    options.sleep.mockImplementationOnce(async () => {
      expect(rest.repos.createDeployment).not.toHaveBeenCalled()
      check.status = 'completed'
    })

    await reportCloudflareDeployments(options)

    expect(options.sleep).toHaveBeenCalled()
    expect(rest.repos.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ ref: commit }),
    )
    expect(rest.repos.createDeploymentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'success' }),
    )
  })

  it('does not use the privileged Test fallback for a fork workflow', async () => {
    const { options, rest } = setup()
    options.context.eventName = 'workflow_run'
    delete options.context.payload.check_run
    options.context.payload.workflow_run = {
      head_sha: commit,
      head_repository: { full_name: 'someone/bladevault' },
    }

    await reportCloudflareDeployments(options)

    expect(options.github.paginate).not.toHaveBeenCalled()
    expect(rest.repos.createDeployment).not.toHaveBeenCalled()
    expect(rest.repos.createDeploymentStatus).not.toHaveBeenCalled()
  })

  it('reports a completed build once when Cloudflare leaves its starter check in progress', async () => {
    const { checks, options, rest } = setup()
    checks.unshift({
      ...makeCheck(),
      id: 99,
      status: 'in_progress',
      conclusion: null,
      completed_at: null,
    })

    await reportCloudflareDeployments(options)

    expect(rest.repos.createDeployment).toHaveBeenCalledOnce()
    expect(rest.repos.createDeploymentStatus).toHaveBeenCalledOnce()
    expect(rest.repos.createDeploymentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'success' }),
    )
  })

  it('does not let another pending build block a completed build on the same commit', async () => {
    const { checks, options, rest } = setup()
    const pendingId = 'ccdc61ac-4efb-433c-8f09-0fce2aefbe80'
    checks.push({
      ...makeCheck(),
      id: 101,
      external_id: pendingId,
      details_url: productionLog.replace(buildId, pendingId),
      status: 'in_progress',
      conclusion: null,
      completed_at: null,
    })

    await reportCloudflareDeployments(options)

    expect(rest.repos.createDeployment).toHaveBeenCalledOnce()
    expect(rest.repos.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ build_id: buildId }),
      }),
    )
  })
})
