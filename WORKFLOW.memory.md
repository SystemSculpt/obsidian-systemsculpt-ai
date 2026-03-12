---
tracker:
  kind: memory
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
    - Done
polling:
  interval_ms: 1000
workspace:
  root: ~/gits/tmp/symphony/obsidian-systemsculpt-ai-memory
hooks:
  timeout_ms: 1800000
  after_create: |
    git clone /Users/systemsculpt/gits/obsidian-systemsculpt-ai .
    git remote set-url origin https://github.com/SystemSculpt/obsidian-systemsculpt-ai.git
    mkdir -p .codex
    if [ -d /Users/systemsculpt/gits/obsidian-systemsculpt-ai/.codex/skills ]; then
      rm -rf .codex/skills
      cp -R /Users/systemsculpt/gits/obsidian-systemsculpt-ai/.codex/skills .codex/skills
    fi
    npm ci
agent:
  max_concurrent_agents: 1
  max_turns: 10
codex:
  command: codex --config shell_environment_policy.inherit=all --config model_reasoning_effort=high app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
observability:
  dashboard_enabled: true
  refresh_ms: 1000
  render_interval_ms: 16
---

You are running a local Symphony smoke test against `obsidian-systemsculpt-ai`.

Goal:

- Prove that Symphony can bootstrap the plugin repository, interpret the issue, and leave behind useful evidence in the workspace.

Rules:

1. Treat the issue description as the full task contract.
2. Do not commit, push, or open a PR.
3. Prefer read-only or low-risk validation steps.
4. Keep any changes minimal, local, and easy to inspect.

Repo-specific guidance:

- `testing/native/` is the canonical runtime harness. Do not use retired WDIO or separate-instance E2E flows.
- Prefer `npm run check:plugin:fast` for smoke/demo issues unless the issue explicitly requires deeper validation.
- If you need a local report, write it to `.codex/symphony-smoke-report.md` in the workspace.
