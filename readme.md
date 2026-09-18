# touchdown

Github Deployment manager for Github Actions.

Your workflow deploys. touchdown writes the deployment record around it, so it shows up on the timeline and in your environments.

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

  # your deploy step, then:

  - name: Finish deployment
    if: ${{ !cancelled() }}
    uses: martinmiglio/touchdown@<sha>
    with:
      mode: finish
      group: pr:${{ github.event.pull_request.number }}
      targets: '[{"environment":"pr-preview","url":"${{ steps.deploy.outputs.preview_url }}"}]'
      status: ${{ steps.deploy.outcome == 'success' && 'success' || 'failure' }}
      # outputs: deployments and retired, both JSON strings
```

Compare the outcome against a literal. Step outcomes are strings, and `skipped` is truthy, so `|| 'failure'` never fires.

## Options

```yaml
- uses: martinmiglio/touchdown@<sha>
  with:
    # start, finish, or deactivate
    mode: finish

    # the lifecycle this belongs to: pr:123, prod, ...
    group: pr:123

    # one deployment per target; url is used on success
    targets: '[{"environment":"pr-preview","url":"https://example.com","logUrl":"https://example.com/logs","description":"preview"}]'

    # commit or ref name; defaults to the pull request head, else the pushed commit
    ref: ""

    # finish only: success, failure, error, cancelled, or skipped
    status: success

    # mark the environment transient or production
    transient: false
    production: false

    # reuse an existing deployment for this group and ref instead of creating one
    reuse: true

    # on a successful finish, mark older deployments in the group inactive
    retire: true

    # required before retire will touch production deployments
    retire-production: false

    # true stops at the first error, false tries every target
    fail-on-error: true
```

## Teardown

```yaml
on:
  pull_request:
    types: [closed]

steps:
  # same group as start; a no-op when there is nothing to clean up
  - uses: martinmiglio/touchdown@<sha>
    with:
      mode: deactivate
      group: pr:${{ github.event.pull_request.number }}
```

## Notes

- The status you pass never fails the step. A failed deploy is still a correct record.
- Fork pull requests get a read-only token, so touchdown cannot write there.
- touchdown only touches deployments it created.
