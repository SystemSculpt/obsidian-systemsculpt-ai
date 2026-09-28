import type { StudioService } from '../../studio/StudioService';
import type { StudioProjectV1 } from '../../studio/types';

export async function startStudioIndependentRun(project: StudioProjectV1 | null, path: string, nodeId: string | undefined, service: () => StudioService, flush: () => Promise<void>, onError: (message: string) => void): Promise<boolean> {
  if (!project?.graph.nodes.some(node => node.id === nodeId && node.kind === 'studio.codex')) return false;
  try { await flush(); await service().startAgentRun(path, nodeId!); }
  catch (error) { onError(error instanceof Error ? error.message : 'Could not start Codex.'); }
  return true;
}
