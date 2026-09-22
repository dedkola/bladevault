# Dependabot auto-merge credential

Dependabot PRs use `.github/workflows/dependabot-auto-merge.yml` to enable squash auto-merge for non-major updates. The merge must be authenticated with a credential other than the workflow's `GITHUB_TOKEN`: GitHub suppresses `push` workflow runs caused by `GITHUB_TOKEN`, which prevents the `Test` workflow and its gated container publication job from running on `main`.

Create a fine-grained personal access token for the `dedkola/bladevault` repository with **Contents: Read and write** and **Pull requests: Read and write** permissions. Set an expiration and arrange rotation before it expires. Store it as the repository **Dependabot secret** `AUTO_MERGE_TOKEN` under **Settings → Secrets and variables → Dependabot**. Do not put the token in the repository or in an Actions secret: Dependabot-triggered workflows receive Dependabot secrets, not Actions secrets.

The metadata step continues to use `GITHUB_TOKEN`; only `gh pr merge` uses `AUTO_MERGE_TOKEN`. If the secret is missing, the auto-merge step fails with an explicit error instead of silently merging without a `main` build.

After rotating the token, verify a Dependabot PR's auto-merge request is enabled by the token owner and that its merge creates a `push` run of `Test`. A successful `Test` run on `main` must include **Verify & publish container** for both architectures and publish the multi-platform manifest.
