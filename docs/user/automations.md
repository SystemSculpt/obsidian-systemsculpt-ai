# Automations

Automations process notes from capture folders into destination folders using SystemSculpt workflow rules.

## Configure

Open `Settings -> SystemSculpt AI -> Workflow`.

Automation settings now live inside the `Workflow` tab.

Current built-in workflow automations (`src/constants/workflowAutomations.ts`):

- Meeting Transcript -> Summary + Tasks
- Web Clipping -> Summary + Insights
- Idea Dump -> Project Inbox

Each card lets you configure:

- Capture source folder
- Destination folder
- Enable automation toggle

## Commands

- `Run Workflow Automation` (for active markdown note)
- `Show Automation Backlog`

## Notes

- Automations run against markdown notes.
- `Skipped workflow items` can be cleared from the `Workflow` tab.
