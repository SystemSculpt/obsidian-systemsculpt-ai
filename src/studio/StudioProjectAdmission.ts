import { StudioGraphCompiler } from "./StudioGraphCompiler";
import { builtInStudioNodeRegistry } from "./StudioBuiltInNodes";
import { assertValidStudioProjectAgentDocumentStructure } from "./StudioProjectAgentDocumentValidation";
import { readAndMigrateStudioProject, type StudioProjectParseContext } from "./schema";
import type { StudioProjectV1 } from "./types";

/** Pure document admission: validate external structure before compatibility normalization and compilation. */
export function admitStudioProjectText(raw: string, context?: StudioProjectParseContext): {
  record: Record<string, unknown>;
  project: StudioProjectV1;
} {
  const record: unknown = JSON.parse(raw);
  assertValidStudioProjectAgentDocumentStructure(record);
  const project = readAndMigrateStudioProject(record, context);
  // Layout settings are import hints. Legacy coordinate recovery has already
  // run; accepted authored state uses the manual layout written by Studio.
  project.graph.layout = { mode: "manual" };
  validateStudioProjectDocument(project);
  return { record: record as Record<string, unknown>, project };
}

export function validateStudioProjectDocument(project: StudioProjectV1): void {
  // Document-mode compile: this gate decides whether Studio will adopt and
  // open a project file at all, so it must accept every state Studio itself
  // can persist (placeholder nodes, unfinished configs, unwired required
  // inputs). Run readiness is enforced separately by the runtime's strict
  // compile when the user actually runs the graph.
  //
  // graph.entryNodeIds is deliberately not validated here. It is derived
  // data: the canvas recomputes it on every mutation and planStudioRun
  // re-derives real entry points from executable-graph structure, ignoring
  // the persisted list. The visual-only classification also changes across
  // plugin versions (studio.text became executable in 6.2.x), so rejecting
  // an entry by kind bricks files persisted by a sibling build. parse
  // drops entry IDs that reference missing nodes.
  new StudioGraphCompiler().compile(project, builtInStudioNodeRegistry, { validation: "document" });
}
