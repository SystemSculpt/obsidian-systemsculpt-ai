import type {
  StudioNodeRunDisplayState,
  StudioRunLifecycleStatus,
} from "../StudioRunPresentationState";
import {
  createNodeActivity,
  edgeActivityFromSource,
  nodeActivityFromAgentRun,
  nodeActivityFromRunState,
  type StudioAgentRunActivitySource,
  type StudioEdgeActivityPhase,
  type StudioNodeActivity,
  type StudioPortActivityPhase,
} from "./StudioActivity";

type StudioActivityGraph = Readonly<{
  nodes: ReadonlyArray<Readonly<{ id: string; kind: string }>>;
  edges: ReadonlyArray<
    Readonly<{ id: string; fromNodeId: string; fromPortId: string; toNodeId: string; toPortId: string }>
  >;
}>;

export type StudioActivityAgentRun = StudioAgentRunActivitySource &
  Readonly<{ id: string; nodeId: string; updatedAt: string }>;

export type StudioActivitySnapshot = Readonly<{
  nodes: ReadonlyMap<string, StudioNodeActivity>;
  edges: ReadonlyMap<string, StudioEdgeActivityPhase>;
  ports: ReadonlyMap<string, StudioPortActivityPhase>;
}>;

export type StudioActivityProjectionInput = Readonly<{
  graph: StudioActivityGraph | null;
  runStatus: StudioRunLifecycleStatus;
  getNodeRunState: (nodeId: string) => StudioNodeRunDisplayState;
  /** Native Codex run records for the open project. */
  agentRuns?: ReadonlyArray<StudioActivityAgentRun>;
  /** Managed output placeholders that are still waiting for their result. */
  isPlaceholder?: (nodeId: string) => boolean;
  /** Active runs another machine left unchanged for a while: shown settled, never live. */
  isStaleAgentRun?: (runId: string) => boolean;
}>;

/** @internal Unit-tested directly. */
export function portActivityKey(nodeId: string, direction: "in" | "out", portId: string): string {
  return `${nodeId}:${direction}:${portId}`;
}

export const EMPTY_ACTIVITY_SNAPSHOT: StudioActivitySnapshot = Object.freeze({
  nodes: new Map<string, StudioNodeActivity>(),
  edges: new Map<string, StudioEdgeActivityPhase>(),
  ports: new Map<string, StudioPortActivityPhase>(),
});

const AGENT_RUN_LIVE = new Set(["queued", "running", "waiting"]);

function latestAgentRunByNode(
  runs: ReadonlyArray<StudioActivityAgentRun> | undefined,
  isLive: (run: StudioActivityAgentRun) => boolean
): Map<string, StudioActivityAgentRun> {
  const byNode = new Map<string, StudioActivityAgentRun>();
  for (const run of runs || []) {
    const current = byNode.get(run.nodeId);
    if (!current) {
      byNode.set(run.nodeId, run);
      continue;
    }
    const currentLive = isLive(current);
    const nextLive = isLive(run);
    if (nextLive !== currentLive) {
      if (nextLive) byNode.set(run.nodeId, run);
      continue;
    }
    if (String(run.updatedAt) > String(current.updatedAt)) byNode.set(run.nodeId, run);
  }
  return byNode;
}

/**
 * Pure derivation of every activity surface from the run presentation, the
 * graph topology, and native Codex runs. Idempotent: replaying the same input
 * yields the same snapshot, so restore-after-reload and live updates share one
 * code path. Nothing here touches the DOM.
 */
export function projectStudioActivity(input: StudioActivityProjectionInput): StudioActivitySnapshot {
  const graph = input.graph;
  if (!graph) return EMPTY_ACTIVITY_SNAPSHOT;

  const isStale = (run: StudioActivityAgentRun): boolean => input.isStaleAgentRun?.(run.id) ?? false;
  const isLive = (run: StudioActivityAgentRun): boolean => AGENT_RUN_LIVE.has(run.status) && !isStale(run);
  const agentRuns = latestAgentRunByNode(input.agentRuns, isLive);
  const nodes = new Map<string, StudioNodeActivity>();
  for (const node of graph.nodes) {
    if (input.isPlaceholder?.(node.id)) {
      nodes.set(node.id, createNodeActivity("active", { label: "Generating" }));
      continue;
    }
    const fromRun = nodeActivityFromRunState(input.getNodeRunState(node.id), input.runStatus);
    const agentRun = agentRuns.get(node.id);
    if (!agentRun) {
      nodes.set(node.id, fromRun);
      continue;
    }
    const fromAgent = nodeActivityFromAgentRun(agentRun, isStale(agentRun));
    // A live native run owns the card; otherwise a live graph run does; a
    // settled or stale native run still reports itself when the graph is quiet.
    if (isLive(agentRun)) nodes.set(node.id, fromAgent);
    else if (fromRun.phase !== "idle") nodes.set(node.id, fromRun);
    else nodes.set(node.id, fromAgent);
  }

  const edges = new Map<string, StudioEdgeActivityPhase>();
  const ports = new Map<string, StudioPortActivityPhase>();
  for (const edge of graph.edges) {
    const source = nodes.get(edge.fromNodeId);
    const phase = source ? edgeActivityFromSource(source.phase, input.runStatus) : "idle";
    edges.set(edge.id, phase);
    if (phase === "surging") {
      ports.set(portActivityKey(edge.fromNodeId, "out", edge.fromPortId), "emitting");
      ports.set(portActivityKey(edge.toNodeId, "in", edge.toPortId), "receiving");
    }
  }

  return { nodes, edges, ports };
}
