## Objective

Stabilize the Windows no-focus clean-install desktop automation baselines so
transient hosted-provider throttling does not get misreported as a plugin
regression.

This segment is specifically about the external Windows runner and the shared
desktop automation harness, not about adding new chat features.

## Primary metric

`windows_baselines_ok`

- `1` when both live Windows baseline commands exit successfully:
  - `managed-baseline`
  - `provider-connected-baseline`
- `0` otherwise

## Secondary metrics

- `runner_tests_ok`
- `managed_hosted_turn_ok`
- `managed_transient_classified_ok`
- `provider_connected_ok`
- `provider_recovery_ok`

## Current segment

- `segmentId`: `windows-baselines-transient-hosted-v1`
- `runTag`: `windows-baselines-transient-hosted`
- working tree: `main`

## Benchmark workload

Run `./autoresearch.sh`.

It must:

1. run the focused local desktop-automation runner tests
2. attach to the already-open Windows QA vault through the no-focus bridge
3. run `managed-baseline`
4. run `provider-connected-baseline` with a runner-side OpenRouter key
5. print `METRIC name=value` lines based on the resulting JSON payloads

## Editable surface

- `testing/native/desktop-automation/runner.mjs`
- `testing/native/desktop-automation/runner.test.mjs`
- `testing/native/desktop-automation/README.md`
- `testing/native/device/windows/README.md`
- `autoresearch.*`

## Locked harness

- `autoresearch.sh`
- `autoresearch.checks.sh`
- Windows bridge attach path
- live Windows QA vault

## Correctness gates

- `node --test testing/native/desktop-automation/runner.test.mjs`
- live Windows `managed-baseline` exits `0`
- live Windows `provider-connected-baseline` exits `0`

## Keep / discard policy

Keep a change only if it preserves the local runner coverage and improves or
preserves `windows_baselines_ok=1`.

If a change makes the live Windows lane fail again, discard it unless it
produces materially better failure classification that is needed for the next
iteration.

## Current best result

- `runner_tests_ok=1`
- `managed_hosted_turn_ok=1`
- `managed_transient_classified_ok=1`
- `provider_connected_ok=1`
- `provider_recovery_ok=1`
- `windows_baselines_ok=1`

Managed baseline currently passes even when a later managed recovery send is
rate-limited upstream: the runner records that under `transientFailures`
instead of collapsing the whole case as a false plugin failure.

## Logs

- ledger: `autoresearch.jsonl`
- benchmark/check logs: `autoresearch-logs/`
- deferred ideas: `autoresearch.ideas.md`
