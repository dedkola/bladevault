# Documentation site updates

The manuals are maintained in this repository under `docs/`. The `bladevault-web`
site downloads those files during its build and generates the `/docs` pages,
navigation, images, and search index.

The **Refresh documentation site** workflow requests a new site build whenever
`docs/**` or the workflow itself changes on `main`. Pull requests and other
branches do not trigger a deployment. New pages must also be listed in
`docs/SUMMARY.md`.

## One-time setup

The site is an assets-only Cloudflare Worker (`bladevault-web`) built by
Workers Builds from the `dedkola/bladevault-web` repository.

1. In the Cloudflare dashboard, open **Workers & Pages → bladevault-web →
   Settings → Builds → Deploy Hooks**. The Worker must already be connected to
   Git.
2. Create a hook named **BladeVault docs updates** for the `main` branch, or reuse
   an existing hook for that branch.
3. In the **dedkola/bladevault** GitHub repository, open **Settings → Secrets and
   variables → Actions**. Save the hook URL
   (`https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/…`) as the
   repository secret `BLADEVAULT_WEB_DOCS_DEPLOY_HOOK`.
4. Keep the site's `DOCS_REF` build variable unset or set to `main`. A pinned tag
   or commit will continue to serve that revision even when a rebuild is
   requested. The build command must run `pnpm build`, including its `prebuild`
   docs fetch.

Treat the hook URL as a secret: anyone with it can request a site build. Store
it only in the Actions secret, never in source control or logs. Cloudflare
limits builds to 10 per minute per Worker. If an identical build is already
queued, the hook reuses it.

See [Cloudflare's Workers Builds deploy hooks documentation](https://developers.cloudflare.com/workers/ci-cd/builds/deploy-hooks/).

## Manual refresh and verification

Open **Actions → Refresh documentation site → Run workflow**, choose `main`, and
run it. Manual runs on other branches are skipped.

A successful workflow means Cloudflare accepted the rebuild request; it does not
mean the build or deploy has finished. The job summary shows the build ID. Check
that build under the `bladevault-web` Worker's **Deployments → Builds** and its
`[docs]` log lines for the fetched BladeVault commit. Then verify the changed
page on the published site.

If the Actions secret is missing or Cloudflare rejects the request, the workflow fails
with an error. If the site build cannot download the docs, its existing pipeline
may fall back to a cached revision with a warning; inspect the build log before
assuming the latest changes were published.
