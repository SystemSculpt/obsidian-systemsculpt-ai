import { sha256HexFromBytesPortable } from "../../utils/sha256";
import * as Automerge from "@automerge/automerge/slim";
import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64";
import { base64ToBytes, bytesToBase64 } from "../../utils/base64";
import type { StudioProjectEntities } from "./StudioProjectEntities";

export type StudioMergeState = { engine: "automerge"; state: string; heads: string[] };
type Value = StudioProjectEntities[string][string];
type State = { projectId: string; entities: StudioProjectEntities; deleted: Record<string, boolean> };
export type StudioCollaborativeState = Automerge.Doc<State>;
let initialization: Promise<void> | null = null;
export function initializeStudioCollaboration(): Promise<void> {
  return initialization ||= Automerge.initializeBase64Wasm(automergeWasmBase64);
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const clone = <T>(value: T): T => JSON.parse(canonical(value)) as T;
const actor = (value: unknown): string => sha256HexFromBytesPortable(new TextEncoder().encode(canonical(value)));
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, Value> => !!value && typeof value === "object" && !Array.isArray(value);
const textFields = new Set(["value", "prompt", "systemPrompt", "source", "text", "title", "label", "description", "instructions"]);

export async function createStudioCollaboration(projectId: string, entities: StudioProjectEntities): Promise<StudioCollaborativeState> {
  await initializeStudioCollaboration();
  return Automerge.change(Automerge.init<State>({actor: actor(["studio-root", projectId, entities])}), {time: 0}, draft => { draft.projectId = projectId; draft.entities = clone(entities); draft.deleted = {}; });
}
export async function loadStudioCollaboration(document: StudioMergeState, projectId: string): Promise<StudioCollaborativeState> {
  await initializeStudioCollaboration();
  return loadInitializedStudioCollaboration(document, projectId);
}
export function loadInitializedStudioCollaboration(document: StudioMergeState, projectId: string): StudioCollaborativeState {
  if (document.engine !== "automerge" || typeof document.state !== "string") throw new Error("Unsupported Studio merge state.");
  const state = Automerge.load<State>(base64ToBytes(document.state));
  try {
    if (state.projectId !== projectId || !state.entities || !state.deleted) throw new Error("Studio document and merge state identities differ.");
    if (JSON.stringify(Automerge.getHeads(state).sort()) !== JSON.stringify([...document.heads].sort())) throw new Error("Studio merge state revision does not match its heads.");
    return state;
  } catch (error) { Automerge.free(state); throw error; }
}
export function serializeStudioCollaboration(state: StudioCollaborativeState): StudioMergeState {
  return {engine: "automerge", state: bytesToBase64(Automerge.save(state)), heads: Automerge.getHeads(state)};
}
export function studioCollaborationEntities(state: StudioCollaborativeState): StudioProjectEntities {
  const entities: StudioProjectEntities = Object.create(null);
  for (const [id, value] of Object.entries(state.entities)) if (!state.deleted[id]) entities[id] = clone(value);
  return entities;
}
export function mergeStudioCollaboration(left: StudioCollaborativeState, right: StudioCollaborativeState): StudioCollaborativeState {
  if (left.projectId !== right.projectId) throw new Error("Cannot merge different Studio projects.");
  const copy = Automerge.clone(left);
  try { return Automerge.merge(copy, right); } catch (error) { Automerge.free(copy); throw error; }
}
export function changeStudioCollaboration(
  state: StudioCollaborativeState,
  before: StudioProjectEntities,
  after: StudioProjectEntities,
  options?: {restoreDeletedEntities?: boolean},
): StudioCollaborativeState {
  // A repeated file event or retry represents the same intent, not another
  // insertion. Stable actor and time make importing that intent idempotent.
  const editActor = actor([Automerge.getHeads(state).sort(), before, after, !!options?.restoreDeletedEntities]);
  const copy = Automerge.clone(state, {actor: editActor});
  try { return Automerge.change(copy, {time: 0}, draft => {
    const patch = (target: Record<string, Value>, previous: Record<string, Value>, next: Record<string, Value>, path: string[]): void => {
      for (const key of [...new Set([...Object.keys(previous), ...Object.keys(next)])].sort()) {
        if (JSON.stringify(previous[key]) === JSON.stringify(next[key])) continue;
        if (!own(next, key)) { delete target[key]; continue; }
        const value = next[key];
        if (record(previous[key]) && record(value) && record(target[key])) patch(target[key], previous[key], value, [...path, key]);
        else if (typeof previous[key] === "string" && typeof value === "string" && typeof target[key] === "string" && textFields.has(key)) {
          Automerge.updateText(draft, [...path, key], value);
        } else target[key] = clone(value);
      }
    };
    for (const id of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      if (!own(after, id)) { draft.deleted[id] = true; continue; }
      if (!own(before, id)) {
        if (draft.deleted[id] && !options?.restoreDeletedEntities) throw new Error("Deleted nodes require an explicit Undo or restore.");
        draft.entities[id] = clone(after[id]);
        if (own(draft.deleted, id)) draft.deleted[id] = false;
      } else if (draft.entities[id]) patch(draft.entities[id], before[id], after[id], ["entities", id]);
    }
  }); } catch (error) { Automerge.free(copy); throw error; }
}
export function studioCollaborationAt(state: StudioCollaborativeState, heads: string[]): StudioCollaborativeState {
  return Automerge.clone(Automerge.view(state, heads));
}

/** Release an owned WASM document after its snapshot has been serialized. */
export function releaseStudioCollaboration(state: StudioCollaborativeState): void { Automerge.free(state); }

/** Deterministic ownership for WASM documents, including failed validation/I/O. */
export class StudioCollaborationScope {
  private readonly states = new Set<StudioCollaborativeState>();
  own(state: StudioCollaborativeState): StudioCollaborativeState { this.states.add(state); return state; }
  retain(state: StudioCollaborativeState): void { this.states.delete(state); }
  close(): void { for (const state of this.states) releaseStudioCollaboration(state); this.states.clear(); }
}
