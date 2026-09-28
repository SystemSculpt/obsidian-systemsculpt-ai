# Studio activity module

One contract for everything that shows execution on the canvas.

- StudioActivity.ts — the phase vocabulary (`idle`, `queued`, `active`,
  `waiting`, `done`, `cached`, `failed`, `stopped`) plus pure mappers from
  graph-run state, native Codex runs, and workflow steps. Cable and port
  phases derive from node phases here too.
- StudioActivityProjector.ts — `projectStudioActivity` turns the run
  presentation, the graph topology, and Codex run records into one
  snapshot: node → activity, edge → cable phase, port → pin phase. It is
  pure and idempotent, so live events and restore-after-reload share it.
- StudioActivityDomApplier.ts — patches a snapshot into the live DOM:
  `data-activity` and `aria-busy` on cards, `--ss-activity-progress` and
  `data-activity-progress` for determinate bars, `data-activity` on port
  pins, and cable updates handed to the connection engine. It remembers the
  previous phase so `data-activity-pulse` fires once per real transition.
- StudioActivityBadge.ts — the status row every card renders: dot, phase
  word, percent, detail, optional note. Hidden while idle.

## DOM contract

| Surface | Attribute | Values |
| --- | --- | --- |
| `.ss-studio-node-card` | `data-activity` | node phase |
| `.ss-studio-node-card` | `data-activity-progress` | `determinate` when `--ss-activity-progress` is set |
| `.ss-studio-node-card` | `aria-busy` | `true` while active or waiting |
| `.ss-studio-node-activity` | `data-activity` | node phase (mirrors the card) |
| `.ss-studio-edge-group` | `data-activity` | `idle`, `surging`, `delivered`, `failed` |
| `.ss-studio-port-pin` | `data-activity` | `emitting`, `receiving`, or absent |
| any of the above | `data-activity-pulse` | transition kind, cleared on `animationend` |
| `.ss-studio-run-card`, `.ss-studio-workflow-steps li`, `.ss-studio-workflow-card` | `data-activity` | phase mapped from Codex run or workflow status |

`src/css/views/studio/activity.css` maps each phase to `--ss-activity-color`
and owns every animation. New surfaces adopt `data-activity` and inherit the
same look; they must not add their own status colors. Phase color lives in
the badge, halo, cables and pins only; cards never get a colored stripe.

## Update paths

- Events that only change activity (`node.started` without placeholders,
  `node.progress`, `node.cache_hit`, `node.failed` without placeholders)
  call `applyActivity()` on the view: no DOM rebuild, animations keep phase.
- Structural events (`run.started`, `node.output`, `run.completed`) still
  re-render the graph; `render()` re-applies the snapshot afterwards.
- Codex run changes arrive through `StudioAgentRuns.subscribe` and also
  patch in place.
