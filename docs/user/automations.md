# Automations

Automations process notes from capture folders into destination folders using workflow templates.

## Configure

Open `Settings -> SystemSculpt AI -> Automations`.

Current built-in automation templates (`src/constants/workflowTemplates.ts`):

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
- `Skipped workflow items` can be cleared from the Automations tab.
