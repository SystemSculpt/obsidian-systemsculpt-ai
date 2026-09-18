import type { StudioProjectV1 } from '../types';
import {projectToEntities, entitiesToProject} from './StudioProjectEntities';
import {loadInitializedStudioCollaboration, changeStudioCollaboration, studioCollaborationEntities, serializeStudioCollaboration, mergeStudioCollaboration, StudioCollaborationScope} from './StudioCollaborativeDocument';

/** Capture pending visible edits before an asynchronous operation forks its basis. */
export function materializeStudioProject(project: StudioProjectV1, restoreDeletedEntities = false): StudioProjectV1 {
  if (!project.document) return project;
  const scope = new StudioCollaborationScope();
  try {
    const basis = scope.own(loadInitializedStudioCollaboration(project.document, project.projectId));
    const state = scope.own(changeStudioCollaboration(basis, studioCollaborationEntities(basis), projectToEntities(project), {restoreDeletedEntities}));
    return {...project, document: serializeStudioCollaboration(state)};
  } finally { scope.close(); }
}
export function mergeStudioProjects(local: StudioProjectV1, external: StudioProjectV1): StudioProjectV1 {
  const left = materializeStudioProject(local), right = materializeStudioProject(external);
  if (!left.document || !right.document) throw new Error('Studio collaboration requires initialized documents.');
  const scope = new StudioCollaborationScope();
  try {
    const a = scope.own(loadInitializedStudioCollaboration(left.document, left.projectId));
    const b = scope.own(loadInitializedStudioCollaboration(right.document, right.projectId));
    const merged = scope.own(mergeStudioCollaboration(a, b));
    return entitiesToProject(studioCollaborationEntities(merged), external, serializeStudioCollaboration(merged));
  } finally { scope.close(); }
}
