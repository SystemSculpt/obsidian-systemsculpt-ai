import type { StudioProjectV1 } from '../types';
import {cloneStudioProjectSnapshot} from '../StudioProjectSnapshots';
import {materializeStudioProject, mergeStudioProjects} from './StudioProjectCollaboration';

/** A mounted editor submits changes against the text it actually displayed. */
export class StudioEditorRevision {
  constructor(private basis: StudioProjectV1) {}

  edit(nodeId: string, field: {config: string} | {title: true}, value: string, current: StudioProjectV1): StudioProjectV1 {
    const next = cloneStudioProjectSnapshot(this.basis);
    const node = next.graph.nodes.find(node => node.id === nodeId);
    if (!node) throw new Error('The edited node no longer exists.');
    if ('config' in field) node.config[field.config] = value; else node.title = value;
    this.basis = materializeStudioProject(next);
    return mergeStudioProjects(this.basis, current);
  }
}
