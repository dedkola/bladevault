# Documentation site updates

The manuals are maintained in this repository under `docs/`. The `bladevault-web`
site downloads those files during its build and generates the `/docs` pages,
navigation, images, and search index.

The **Refresh documentation site** workflow requests a new site build whenever
`docs/**` or the workflow itself changes on `main`. Pull requests and other
branches do not trigger a deployment. New pages must also be listed in
`docs/SUMMARY.md`.

## One-time setup

1. Open the **bladevault-web** project in Vercel, then **Settings → Git → Deploy
   Hooks**.
2. Create a hook named **BladeVault docs updates** targeting the site's `main`
   branch, or reuse an existing hook for that branch.
3. In the **dedkola/bladevault** GitHub repository, open **Settings → Secrets and
   variables → Actions**. Save the hook URL as the repository secret
   `BLADEVAULT_WEB_DOCS_DEPLOY_HOOK`.
4. Keep the site's `DOCS_REF` unset or set to `main`. A pinned tag or commit will
   continue to serve that revision even when a rebuild is requested. The Vercel
   build command must run `pnpm build`, including its `prebuild` docs fetch.

Treat the hook URL as a secret: anyone with it can request a site deployment.
Store it only in the Actions secret, never in source control or logs.

See [Vercel's Deploy Hooks documentation](https://vercel.com/docs/deploy-hooks).

## Manual refresh and verification

Open **Actions → Refresh documentation site → Run workflow**, choose `main`, and
run it. Manual runs on other branches are skipped.

A successful workflow means Vercel accepted the rebuild request; it does not mean
the build or publication has finished. Check the `bladevault-web` deployment in
Vercel and its `[docs]` build log for the fetched BladeVault commit. Then verify
the changed page on the published site.

If the Actions secret is missing or Vercel rejects the request, the workflow fails
with an error. If the site build cannot download the docs, its existing pipeline
may fall back to a cached revision with a warning; inspect the build log before
assuming the latest changes were published.
