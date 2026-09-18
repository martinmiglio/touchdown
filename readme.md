# Touchdown

A GitHub Action that keeps correct GitHub Deployment records for a deploy you run yourself. Recorder, not a deployer.

Fixes the Deployments API traps — the `"skipped"` truthy outcome bug, merge-commit refs on PRs, inert `auto_inactive` for transient/production, and unpaginated retirement — while keeping one constant environment per app and scoping every lifecycle to a `group` (e.g. `pr:123`).

## Usage

```yaml
permissions:
  deployments: write

steps:
  - uses: martinmiglio/touchdown@<sha>
    with:
      mode: start
      group: pr:${{ github.event.pull_request.number }}
      targets: '[{"environment":"pr-preview"}]'
      transient: true
```

Pin by SHA; no Marketplace listing yet.

- Product and acceptance criteria: [`product.md`](./product.md)
- Implementation details: [`spec.md`](./spec.md)
