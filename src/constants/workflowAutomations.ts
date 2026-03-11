import type { WorkflowAutomationId } from "../types";

export interface WorkflowAutomationDefinition {
  id: WorkflowAutomationId;
  title: string;
  subtitle: string;
  description: string;
  icon: string;
  capturePlaceholder: string;
  destinationPlaceholder: string;
}

export const WORKFLOW_AUTOMATIONS: WorkflowAutomationDefinition[] = [
  {
    id: "meeting-transcript",
    title: "Meeting Transcript → Summary + Tasks",
    subtitle: "Route transcripts, summarize decisions, push action items",
    description:
      "Watch the Capture Inbox/Transcripts folder, summarize notes, then move them into Areas → Meetings.",
    icon: "mic-2",
    capturePlaceholder: "10 - capture-intake/Transcripts",
    destinationPlaceholder: "40 - areas/Meetings",
  },
  {
    id: "web-clipping",
    title: "Web Clipping → Summary + Insights",
    subtitle: "Normalize clippings, add AI insights, move into Resources",
    description:
      "Drop clippings into Capture Inbox/Clippings and we’ll normalize and refile them into Resources → Web.",
    icon: "globe",
    capturePlaceholder: "10 - capture-intake/Clippings",
    destinationPlaceholder: "20 - resources/Web",
  },
  {
    id: "idea-dump",
    title: "Idea Dump → Project Inbox",
    subtitle: "Triage scratch ideas into projects or areas",
    description:
      "Catch quick ideas in Capture Inbox/Inbox and move refined notes into Projects → Incubator.",
    icon: "lightbulb",
    capturePlaceholder: "10 - capture-intake/Inbox",
    destinationPlaceholder: "30 - projects/Incubator",
  },
];
