---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: "51fe4df40763"
  active_states:
    - Todo
    - In Progress
    - Human Review
    - Rework
    - Merging
  terminal_states:
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
    - Done
polling:
  interval_ms: 5000
workspace:
  root: ~/gits/tmp/symphony/obsidian-systemsculpt-ai
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
  max_turns: 20
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
server:
  port: 4011
---

You are working in the `obsidian-systemsculpt-ai` repository, the SystemSculpt AI Obsidian plugin.

Issue context:

- Identifier: {{ issue.identifier }}
- Title: {{ issue.title }}
- Current status: {{ issue.state }}
- Labels: {{ issue.labels }}
- URL: {{ issue.url }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

Execution rules:

1. This is an unattended orchestration run. Do not ask a human to perform follow-up actions.
2. Work only in the provided repository copy.
3. Keep progress grounded in evidence from code, tests, and the current repo state.
4. Do not commit, push, or open a PR unless the issue description explicitly asks you to publish changes.

Repo-specific guidance:

- `testing/native/` is the canonical integration harness for runtime validation.
- Do not revive the retired WDIO or separate-instance E2E flow. If runtime proof is needed, use the narrowest relevant native smoke command instead.
- Treat `npm run check:plugin` as the baseline validation for TypeScript/plugin behavior changes.
- Use `npm test` for unit and behavior coverage when source behavior changes.
- Run `npm run build` if you touch release-visible bundle surfaces or generated plugin artifacts.
- For runtime, UI, or device-sensitive changes, use the narrowest applicable command from `testing/native/` when the required local setup exists. If it does not, record the blocker clearly and continue with the best available local proof.

Preferred working loop:

1. Capture `git branch --show-current`, `git status --short`, and `git rev-parse HEAD`.
2. Read the relevant code paths and any tests/docs tied to the issue.
3. Make focused changes that keep the repo's current SystemSculpt-only product direction intact.
4. Run the narrowest proof that actually demonstrates the changed behavior.
5. Summarize completed work, proof, and blockers with no "next steps for user" section.
