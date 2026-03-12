repo_root =
  System.get_env("SYMPHONY_SMOKE_REPO_ROOT") ||
    Path.expand(Path.join(__DIR__, ".."))

workflow_path =
  System.get_env("SYMPHONY_SMOKE_WORKFLOW_PATH") ||
    Path.join(repo_root, "WORKFLOW.memory.md")

issue_identifier = System.get_env("SYMPHONY_SMOKE_ISSUE_IDENTIFIER") || "SYM-MEM-1"
issue_title = System.get_env("SYMPHONY_SMOKE_ISSUE_TITLE") || "Smoke bootstrap the Obsidian plugin repo"

issue_description =
  System.get_env("SYMPHONY_SMOKE_ISSUE_DESCRIPTION") ||
    """
    Local smoke only.

    Prove Symphony can bootstrap this repository by:
    1. Capturing branch, git status, and HEAD.
    2. Running `npm run check:plugin:fast`.
    3. Writing `.codex/symphony-smoke-report.md` with the commands you ran, the result, and any blockers.

    Do not commit, push, or modify product source files unless required to make the smoke proof legible.
    """

timeout_ms =
  case Integer.parse(System.get_env("SYMPHONY_SMOKE_TIMEOUT_MS") || "180000") do
    {value, ""} when value > 0 -> value
    _ -> 180_000
  end

issue = %SymphonyElixir.Linear.Issue{
  id: "memory-obsidian-plugin-smoke",
  identifier: issue_identifier,
  title: issue_title,
  description: issue_description,
  state: "Todo",
  url: "memory://#{issue_identifier}",
  labels: ["symphony", "memory-smoke"]
}

Application.put_env(:symphony_elixir, :workflow_file_path, workflow_path)
Application.put_env(:symphony_elixir, :memory_tracker_issues, [issue])
Application.put_env(:symphony_elixir, :memory_tracker_recipient, self())

{:ok, _apps} = Application.ensure_all_started(:symphony_elixir)
:ok = SymphonyElixir.Workflow.set_workflow_file_path(workflow_path)

IO.puts("Symphony memory smoke started")
IO.puts("workflow=#{workflow_path}")
IO.puts("workspace_root=#{SymphonyElixir.Config.settings!().workspace.root}")
IO.puts("issue_identifier=#{issue_identifier}")
IO.puts("timeout_ms=#{timeout_ms}")

deadline_ms = System.monotonic_time(:millisecond) + timeout_ms

loop = fn loop_fn ->
  remaining_ms = deadline_ms - System.monotonic_time(:millisecond)

  if remaining_ms <= 0 do
    IO.puts("Smoke timeout reached; stopping Symphony.")
    :ok = Application.stop(:symphony_elixir)
  else
    receive do
      {:memory_tracker_comment, issue_id, body} ->
        IO.puts("memory_tracker_comment issue_id=#{issue_id}")
        IO.puts(body)
        loop_fn.(loop_fn)

      {:memory_tracker_state_update, issue_id, state_name} ->
        IO.puts("memory_tracker_state_update issue_id=#{issue_id} state=#{state_name}")
        loop_fn.(loop_fn)
    after
      min(remaining_ms, 1000) ->
        loop_fn.(loop_fn)
    end
  end
end

loop.(loop)
