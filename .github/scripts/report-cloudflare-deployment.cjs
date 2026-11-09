const { setTimeout: delay } = require('node:timers/promises')

const APP_ID = 85455
const APP_SLUG = 'cloudflare-workers-and-pages'
const CHECK_NAME = 'Workers Builds: bladevault'
const SOURCE = 'cloudflare-workers-builds'
const DASHBOARD_PATH =
  '/73026fc18aa364a3cc60305b6c6fb75c/workers/services/view/bladevault/production/'
// Workers Previews are served at <preview-name>-<worker>.<account subdomain>.
const PREVIEW_HOST_SUFFIX = '-bladevault.maiden-tech.workers.dev'
const PRODUCTION_URL = 'https://bladevault.tkweb.dev'

// Workers Builds does not include the public preview URL in its check output,
// but its dashboard link names the Preview. Fall back to the build log when the
// name cannot form a valid hostname label.
function previewUrl(name) {
  const label = `${name}${PREVIEW_HOST_SUFFIX.split('.')[0]}`
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) || label.length > 63) {
    return null
  }
  return `https://${name}${PREVIEW_HOST_SUFFIX}`
}

function isCloudflareCheck(run) {
  return (
    run.app?.id === APP_ID &&
    run.app?.slug === APP_SLUG &&
    run.name === CHECK_NAME
  )
}

function buildDetails(run, suite, repository) {
  if (
    !suite.head_branch ||
    suite.head_sha !== run.head_sha ||
    suite.repository?.full_name !== repository ||
    suite.app?.id !== APP_ID ||
    suite.app?.slug !== APP_SLUG
  ) {
    throw new Error(
      'Cloudflare check suite does not identify a repository branch',
    )
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      run.external_id,
    ) ||
    !Number.isFinite(Date.parse(run.completed_at))
  ) {
    throw new Error(
      'Cloudflare check is missing its build ID or completion time',
    )
  }

  const url = new URL(run.details_url)
  const production = suite.head_branch === 'main'
  const suffix = url.pathname.slice(DASHBOARD_PATH.length)
  const previewMatch = /^previews\/([^/]+)\/builds\/([^/]+)$/.exec(suffix)
  const expectedPath = production
    ? suffix === `builds/${run.external_id}`
    : previewMatch?.[2] === run.external_id
  if (
    url.origin !== 'https://dash.cloudflare.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(DASHBOARD_PATH) ||
    !expectedPath
  ) {
    throw new Error('Cloudflare build URL does not match the Worker and branch')
  }

  return {
    environment: production ? 'Production' : 'Preview',
    production,
    branch: suite.head_branch,
    // A failed Preview build may have no live site yet; link its log instead.
    environmentUrl: production
      ? PRODUCTION_URL
      : (run.conclusion === 'success' && previewUrl(previewMatch[1])) ||
        url.href,
    logUrl: url.href,
  }
}

module.exports = async function reportCloudflareDeployments({
  github,
  context,
  core,
  sleep = delay,
}) {
  const { owner, repo } = context.repo
  const repository = `${owner}/${repo}`
  const { payload } = context
  if (
    context.eventName === 'workflow_run' &&
    payload.workflow_run.head_repository?.full_name !== repository
  ) {
    core.info(
      'Skipping CI from a fork; only Cloudflare checks in this repository are reported',
    )
    return
  }
  const sha =
    payload.check_run?.head_sha ||
    payload.workflow_run?.head_sha ||
    payload.inputs?.commit_sha ||
    context.sha
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error('An exact 40-character commit SHA is required')
  }

  let runs = []
  // CI can finish before Cloudflare. Bound reconciliation to 4.5 minutes.
  const attempts = context.eventName === 'workflow_run' ? 10 : 1
  for (let attempt = 0; attempt < attempts; attempt++) {
    const checks = (
      await github.paginate(github.rest.checks.listForRef, {
        owner,
        repo,
        ref: sha,
        app_id: APP_ID,
        check_name: CHECK_NAME,
        filter: 'all',
        per_page: 100,
      })
    ).filter(isCloudflareCheck)
    // Cloudflare can leave its starter check permanently in progress and create
    // a separate completed check for the same build. Only terminal checks count.
    const completed = new Map()
    for (const run of checks) {
      if (run.status !== 'completed') continue
      const previous = completed.get(run.external_id)
      if (!previous || run.id > previous.id) completed.set(run.external_id, run)
    }
    runs = [...completed.values()]
    if (runs.length) break
    if (attempt + 1 < attempts) await sleep(30_000)
  }

  if (!runs.length) {
    throw new Error(
      `Cloudflare has not finished reporting builds for ${sha}; retry this workflow later`,
    )
  }
  runs.sort((a, b) => Date.parse(a.completed_at) - Date.parse(b.completed_at))

  for (const run of runs) {
    const states = {
      success: 'success',
      failure: 'failure',
      cancelled: 'failure',
      timed_out: 'error',
      action_required: 'failure',
    }
    let state = states[run.conclusion]
    if (!state) {
      core.info(
        `Skipping Cloudflare ${run.conclusion} check ${run.id}; it did not deploy`,
      )
      continue
    }
    if (run.head_sha !== sha)
      throw new Error(
        'Cloudflare check SHA does not match the requested commit',
      )
    const { data: suite } = await github.rest.checks.getSuite({
      owner,
      repo,
      check_suite_id: run.check_suite.id,
    })
    const build = buildDetails(run, suite, repository)
    const params = { owner, repo, environment: build.environment }
    const deployments = await github.paginate(
      github.rest.repos.listDeployments,
      { ...params, sha, per_page: 100 },
    )
    let deployment = deployments.find(
      (item) =>
        item.payload?.source === SOURCE &&
        item.payload.build_id === run.external_id,
    )

    if (!deployment) {
      const response = await github.rest.repos.createDeployment({
        ...params,
        ref: sha,
        auto_merge: false,
        required_contexts: [],
        production_environment: build.production,
        transient_environment: !build.production,
        description: `Cloudflare Workers Builds: ${build.branch}`.slice(0, 140),
        payload: {
          source: SOURCE,
          build_id: run.external_id,
          check_run_id: run.id,
          branch: build.branch,
          conclusion: run.conclusion,
          completed_at: run.completed_at,
        },
      })
      if (response.status !== 201 || !response.data.id) {
        throw new Error(
          'GitHub did not create the Cloudflare deployment record',
        )
      }
      deployment = response.data
    }

    // Check after creation so a concurrent newer record is visible before status
    // publication. A delayed event/backfill must not replace a newer live build.
    const { data: recent } = await github.rest.repos.listDeployments({
      ...params,
      per_page: 100,
    })
    if (
      state === 'success' &&
      recent.some(
        (item) =>
          item.payload?.source === SOURCE &&
          item.payload.branch === build.branch &&
          item.payload.conclusion === 'success' &&
          Date.parse(item.payload.completed_at) > Date.parse(run.completed_at),
      )
    ) {
      state = 'inactive'
    }

    const status = {
      owner,
      repo,
      deployment_id: deployment.id,
      state,
      log_url: build.logUrl,
      environment_url: build.environmentUrl,
      auto_inactive: false,
      description: `Cloudflare build ${run.conclusion}${state === 'inactive' ? ' (superseded)' : ''}`,
    }
    const { data: existingStatuses } =
      await github.rest.repos.listDeploymentStatuses({
        owner,
        repo,
        deployment_id: deployment.id,
        per_page: 1,
      })
    const previous = existingStatuses[0]
    if (
      previous?.state !== status.state ||
      previous?.log_url !== status.log_url ||
      previous?.environment_url !== status.environment_url
    ) {
      await github.rest.repos.createDeploymentStatus(status)
    }
    core.info(
      `Reported ${build.environment} ${sha}: Cloudflare ${run.external_id} (${state})`,
    )
  }
}
