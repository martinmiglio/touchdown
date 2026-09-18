# Touchdown

A GitHub Action that keeps correct GitHub Deployment records for a deploy you run yourself. A recorder, not a deployer: no build, no cloud knowledge, no comments.

## Why

The Deployments API has traps that every hand-rolled workflow falls into. Touchdown fixes five:

1. `steps.<id>.outcome` is the string `"skipped"` (truthy), so naive `||` fallbacks misreport status.
2. `GITHUB_SHA` is the merge commit on `pull_request`, so using it as the deployment `ref` breaks the PR-timeline link. Touchdown defaults to `pull_request.head.sha` on PRs.
3. `auto_inactive` only touches prior non-transient, non-production `success` deployments, so it is inert for transient previews and production. Touchdown always sends `auto_inactive: false` and does its own explicit retirement.
4. `listDeployments` is paginated (default 30); retirement that reads one page silently misses deployments. Touchdown paginates (`per_page: 100`) to a bounded cap of 1,000 and errors loudly past it.
5. Only one `environment_url` is supported per deployment, so multi-app means multi-deployment. Touchdown creates one deployment per target, joined by a shared `group`.

Model: `environment` is the constant app env (e.g. `production`, `pr-preview` — not one per PR). `group` is the lifecycle key (e.g. `pr:123`, `prod`) that scopes reuse, retirement, and deactivation. Every deployment Touchdown creates carries an ownership stamp (`payload: {"managed_by":"touchdown","v":1,"group":"..."}`); it only ever retires or deactivates deployments carrying that stamp.

## Install

v0 is SHA-only: not on the Marketplace, no version tag. Pin the full commit SHA:

```yaml
- uses: martinmiglio/touchdown@<sha>
```

## Permissions

Every workflow using Touchdown needs:

```yaml
permissions:
  deployments: write
```

Declaring `permissions:` zeroes everything unlisted, so add whatever else your deploy steps need alongside it. `deployments: write` implies read; no `contents` permission is needed.

## Inputs / outputs

| Input               | Required     | Default               | Notes                                                                                                                                                     |
| ------------------- | ------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`              | yes          | —                     | `start`, `finish`, or `deactivate`.                                                                                                                       |
| `group`             | yes          | —                     | Lifecycle key, e.g. `pr:123` or `prod`. Scopes reuse, retire, and deactivate.                                                                             |
| `targets`           | start/finish | —                     | JSON array of `{"environment": string, "url"?: string, "logUrl"?: string, "description"?: string}`. Required for start and finish; ignored by deactivate. |
| `ref`               | no           | resolved              | Commit SHA or refname. Defaults to pull_request.head.sha on PRs, else github.sha.                                                                         |
| `status`            | finish       | —                     | One of: success, failure, error, cancelled, skipped. Required for finish.                                                                                 |
| `transient`         | no           | `false`               | Mark created deployments as transient environments.                                                                                                       |
| `production`        | no           | `false`               | Mark created deployments as production environments.                                                                                                      |
| `reuse`             | no           | `true`                | Reuse an existing owned (environment, ref, group) deployment instead of creating one.                                                                     |
| `retire`            | no           | `true`                | On finish success, mark prior owned deployments in scope inactive.                                                                                        |
| `retire-production` | no           | `false`               | Allow retirement of production deployments. Off by default.                                                                                               |
| `fail-on-error`     | no           | `true`                | `true` stops at the first internal error; `false` attempts all targets then fails with all errors.                                                        |
| `token`             | no           | `${{ github.token }}` | Token with deployments: write.                                                                                                                            |

| Output        | Shape                                                            |
| ------------- | ---------------------------------------------------------------- |
| `deployments` | JSON string: `[{"environment","url","deploymentId","statusId"}]` |
| `retired`     | JSON string of deployment ids marked inactive.                   |

Both outputs are JSON strings (Actions outputs are always strings). Consume with `fromJSON`:

```yaml
- name: Show deployment id
  run: echo "${{ fromJSON(steps.finish.outputs.deployments)[0].deploymentId }}"
```

`targets` is the only way to pass environments; there are no scalar aliases in v0. Unknown keys in a target object are an error. Validation rejects bad input before any API call (indexed, e.g. `targets[1].url: …`).

## Recipes

### Constant env — production on push

```yaml
on:
  push:
    branches: [main]
permissions:
  deployments: write
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: martinmiglio/touchdown@<sha>
        id: start
        with:
          mode: start
          group: prod
          targets: '[{"environment":"production"}]'
          production: true

      - name: Deploy
        id: deploy
        run: ./deploy.sh

      - name: Finish deployment
        if: ${{ !cancelled() }}
        uses: martinmiglio/touchdown@<sha>
        with:
          mode: finish
          group: prod
          targets: '[{"environment":"production","url":"https://example.com"}]'
          status: ${{ steps.deploy.outcome == 'success' && 'success' || 'failure' }}
```

Production retirement is guarded: finishing a `production: true` target only retires prior production deployments when `retire-production: true` is also set.

### Per-PR env — transient preview

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  deployments: write
jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: martinmiglio/touchdown@<sha>
        id: start
        with:
          mode: start
          group: pr:${{ github.event.pull_request.number }}
          targets: '[{"environment":"pr-preview"}]'
          transient: true

      - name: Deploy preview
        id: deploy
        run: ./deploy-preview.sh

      - name: Finish deployment
        if: ${{ !cancelled() }}
        uses: martinmiglio/touchdown@<sha>
        with:
          mode: finish
          group: pr:${{ github.event.pull_request.number }}
          targets: '[{"environment":"pr-preview","url":"${{ steps.deploy.outputs.preview_url }}"}]'
          status: ${{ steps.deploy.outcome == 'success' && 'success' || 'failure' }}
```

`ref` defaults to the PR head SHA on `pull_request` events, so the PR timeline links correctly. `transient: true` makes `inactive` render as "destroyed" when the preview is later torn down.

### Multi-app — two targets, one group

One call handles N targets; `finish` applies a single `status` across all of them.

```yaml
permissions:
  deployments: write
steps:
  - uses: martinmiglio/touchdown@<sha>
    id: start
    with:
      mode: start
      group: pr:${{ github.event.pull_request.number }}
      targets: '[{"environment":"pr-preview-frontend"},{"environment":"pr-preview-backend"}]'
      transient: true

  - name: Deploy both apps
    id: deploy
    run: ./deploy.sh

  - name: Finish deployment
    if: ${{ !cancelled() }}
    uses: martinmiglio/touchdown@<sha>
    with:
      mode: finish
      group: pr:${{ github.event.pull_request.number }}
      targets: '[{"environment":"pr-preview-frontend","url":"https://fe.example.com"},{"environment":"pr-preview-backend","url":"https://api.example.com"}]'
      status: ${{ steps.deploy.outcome == 'success' && 'success' || 'failure' }}
```

### Teardown — deactivate on PR close

```yaml
on:
  pull_request:
    types: [closed]
permissions:
  deployments: write
jobs:
  teardown:
    runs-on: ubuntu-latest
    steps:
      - uses: martinmiglio/touchdown@<sha>
        with:
          mode: deactivate
          group: pr:${{ github.event.pull_request.number }}
```

`deactivate` re-discovers deployments by `group` alone (all environments, no id plumbing), posts `inactive` to each owned match, and is a no-op exiting 0 when nothing matches. No `targets` needed — it is ignored.

## The `finish` step shape (same job)

Use exactly this shape:

```yaml
- name: Finish deployment
  if: ${{ !cancelled() }}
  uses: martinmiglio/touchdown@<sha>
  with:
    mode: finish
    group: pr:${{ github.event.pull_request.number }}
    targets: '[{"environment":"pr-preview","url":"${{ steps.deploy.outputs.preview_url }}"}]'
    status: ${{ steps.deploy.outcome == 'success' && 'success' || 'failure' }}
```

Why:

- `if: ${{ !cancelled() }}` runs finish on success, failure, and skipped deploy steps, but not when the run itself was cancelled. Bare `always()` also runs on cancellation (the docs warn against it for anything that could hang); `!cancelled()` is the safer default.
- `steps.deploy.outcome == 'success' && 'success' || 'failure'` compares against a literal string. Never write `steps.deploy.outcome || 'failure'`: any non-empty string is truthy, so the fallback never fires — and `"skipped"` (a deploy step skipped by its own `if`) is a real, expected value, as is `"failure"`. The explicit comparison maps everything that is not success to failure.
- Compare `outcome`, not `conclusion`: `outcome` is the step result before `continue-on-error` is applied; `conclusion` is after. A failing step with `continue-on-error: true` has `outcome: failure` but `conclusion: success` — reading `conclusion` would report success for a failed deploy.
- Touchdown's `status` input accepts `cancelled` and `skipped` too (both map to the `error` deployment state); the recipe above collapses them to `failure` for simplicity. See the cross-job variant for explicit mapping.

## Cross-job variant

When the deploy and the finish live in different jobs, read `needs.<job>.result` and map `cancelled`/`skipped` explicitly:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      deployments: write
    steps:
      - uses: martinmiglio/touchdown@<sha>
        with:
          mode: start
          group: pr:${{ github.event.pull_request.number }}
          targets: '[{"environment":"pr-preview"}]'
          transient: true
      - run: ./deploy.sh
  finish:
    runs-on: ubuntu-latest
    needs: deploy
    if: ${{ !cancelled() }}
    permissions:
      deployments: write
    steps:
      - uses: martinmiglio/touchdown@<sha>
        with:
          mode: finish
          group: pr:${{ github.event.pull_request.number }}
          targets: '[{"environment":"pr-preview"}]'
          status: ${{ needs.deploy.result == 'success' && 'success' || needs.deploy.result == 'cancelled' && 'cancelled' || needs.deploy.result == 'skipped' && 'skipped' || 'failure' }}
```

`needs.<job>.result` is one of `success`, `failure`, `cancelled`, `skipped`. Touchdown maps `cancelled`/`skipped` to the `error` deployment state (hardcoded, no override in v0). Note the finish job needs `if: ${{ !cancelled() }}` because jobs needing a failed job are skipped by default.

## Exit-code contract

The `status` input never fails the step. Recording `failure`, `error`, `cancelled`, or `skipped` is the action working correctly: the deployment carries the red badge, the step exits 0, and downstream steps still run.

Only action-internal errors fail the step (API failures, validation errors, ambiguous re-lookup matches, pagination cap). `fail-on-error` controls batch behavior:

- `true` (default): stop at the first error.
- `false`: attempt every target, still emit `deployments` (successes only) and `retired`, then fail with every indexed error on its own line (`targets[0]: 422 …`).

There is no rollback: partial writes stand. On error, Touchdown never posts `success`.

## Migration from `bobheadxi/deployments`

| Before                                                      | After                                                          |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| `step: start` / `step: finish` (+ `deactivate_environment`) | `mode: start` / `mode: finish` / `mode: deactivate`            |
| `env: <name>` (+ `env_url`, `logs`)                         | `targets: '[{"environment":"<name>","url":"…","logUrl":"…"}]'` |

Behavior changes to know about:

- No id plumbing. `start` and `finish` stay decoupled; `finish`/`deactivate` re-discover deployments by re-lookup (environment + ref + ownership stamp), so teardown-on-PR-close works without passing ids between steps, jobs, or runs.
- Ownership-scoped retirement. Only deployments Touchdown created (matching `payload.managed_by` + `group`) are ever retired or deactivated. Retirement by bare environment name — which could clobber another tool's or a human's deployment — is gone.
- `cancelled`/`skipped` map to `error` via a hardcoded table. They are never mapped to `inactive`.
- No `auto_inactive`. Touchdown always sends `auto_inactive: false` and does explicit, paginated retirement instead (prior art left it defaulted or truthy, where it is inert for transient and production deployments).
- Invalid `status` input fails closed instead of emitting a placeholder.

## Gotchas

- Fork PRs get a read-only `GITHUB_TOKEN`, so Touchdown cannot write deployments there — calls fail closed. Do not "fix" this with `pull_request_target` + checkout: on `pull_request_target` the token is read/write even from a public fork, so checking out and executing PR code is a code-execution hole. If you must use `pull_request_target`, never check out PR code.
- The action never checks out or executes repository code. It is API-only.
- Environment names may contain spaces and Unicode; only `github-pages` is reserved (managed by GitHub Pages).
- Retirement excludes the deployment being finished, acts only on `finish` `success`, and never touches production deployments unless `retire-production: true` is set (the guard keys on the `production` input, not the environment name).
- `deactivate` is idempotent: zero matches is a no-op exiting 0. Re-posting `inactive` is valid and harmless, so retire/deactivate never need to read current statuses.
- `deactivate` tears down every owned deployment in the group across all environments, including production.
- `url`/`logUrl` become public deployment fields and appear in outputs, so never pass presigned/signed URLs (query-string secrets are not stripped). Userinfo URLs are rejected; query-string secrets are not.
- `reuse: false` with the same `ref` on a later run creates a duplicate owned deployment for the same (environment, ref, group), after which reuse/finish fail closed with an ambiguity error until the duplicates are resolved.

## Further reading

- Product and acceptance criteria: [`product.md`](./product.md)
- Implementation spec: [`spec.md`](./spec.md)
