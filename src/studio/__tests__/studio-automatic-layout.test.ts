import { serializeStudioProjectSnapshot } from "../StudioProjectSnapshots";
import { arrangeStudioGraph, inspectStudioGraphLayout } from "../StudioGraphLayout";
import { createEmptyStudioProject, parseStudioProject, serializeStudioProject } from "../schema";
import { assertValidStudioProjectAgentDocumentStructure } from "../StudioProjectAgentDocumentValidation";
import type { StudioNodeInstance } from "../types";

const node = (id: string, parentId?: string): StudioNodeInstance => ({ id, kind: "studio.text", title: id, version: "1.0.0", position: { x: 99, y: 99 }, config: { value: id }, ...(parentId ? { parentId } : {}) });
const project = () => createEmptyStudioProject({ name: "Layout", policyPath: "layout/grants.json", minPluginVersion: "0", maxRuns: 10, maxArtifactsMb: 10 });
const sizes = new Map([['root', { width: 560, height: 180 }], ['script', { width: 350, height: 1172 }], ['result', { width: 560, height: 1213 }], ['ticket', { width: 560, height: 240 }]]);

describe("automatic Studio layout", () => {
  it("places actual expanded cards and whole sections without overlapping, independently of prior coordinates", () => {
    const p = project();
    p.graph.nodes = [node('root'), node('script', 'root'), node('result'), node('ticket', 'result')];
    p.graph.edges = [{ id: 'flow', fromNodeId: 'script', fromPortId: 'text', toNodeId: 'result', toPortId: 'text' }];
    p.graph.groups = [{ id: 'work', name: 'Work', nodeIds: ['script', 'result'] }, { id: 'tickets', name: 'Tickets', nodeIds: ['ticket'] }];
    arrangeStudioGraph(p, sizes);
    expect(inspectStudioGraphLayout(p, sizes).overlaps).toEqual([]);
    const positions = p.graph.nodes.map(n => ({ ...n.position }));
    expect(arrangeStudioGraph(p, sizes)).toEqual([]);
    p.graph.nodes.forEach(n => { n.position = { x: -2000, y: 99999 }; });
    arrangeStudioGraph(p, sizes);
    expect(p.graph.nodes.map(n => n.position)).toEqual(positions);
    expect(p.graph.nodes[3].position.y).toBeGreaterThan(p.graph.nodes[2].position.y + 1213);
    const grown = new Map(sizes).set('script', { width: 350, height: 2400 });
    arrangeStudioGraph(p, grown);
    expect(inspectStudioGraphLayout(p, grown).overlaps).toEqual([]);
  });

  it("handles cycles and disconnected nodes deterministically", () => {
    const p = project(); p.graph.nodes = ['a', 'b', 'c', 'd'].map(id => node(id));
    p.graph.edges = [['a', 'b'], ['b', 'c'], ['c', 'a']].map(([from, to]) => ({ id: from, fromNodeId: from, toNodeId: to, fromPortId: 'text', toPortId: 'text' }));
    arrangeStudioGraph(p);
    expect(inspectStudioGraphLayout(p).overlaps).toEqual([]);
    expect(arrangeStudioGraph(p)).toEqual([]);
  });
  it('aligns grouped peers under their parent and reflows measured growth without inventing an order', () => {
    const p=project();p.graph.nodes=[node('system'),...['scout','worker','inspector','analyst'].map(id=>node(id,'system'))];
    p.graph.groups=[{id:'roles',name:'Roles',nodeIds:['scout','worker','inspector','analyst']}];
    const measurements=new Map(p.graph.nodes.map(n=>[n.id,{width:600,height:n.id==='worker'?900:400}]));
    arrangeStudioGraph(p,measurements);
    expect(new Set(p.graph.nodes.slice(1).map(n=>n.position.y)).size).toBe(1);
    expect(new Set(p.graph.nodes.slice(1).map(n=>n.position.x)).size).toBe(4);
    expect(inspectStudioGraphLayout(p,measurements).overlaps).toEqual([]);
    expect(arrangeStudioGraph(p,measurements)).toEqual([]);
  });

  it("anchors pinned groups and treats drawings as obstacles", () => {
    const p = project(); p.graph.nodes = [node('root'), node('script'), node('result')];
    p.graph.nodes[1].position = { x: 800, y: 99 };
    p.graph.groups = [{ id: 'fixed', name: 'Fixed', nodeIds: ['root', 'script'] }];
    p.graph.layout = { mode: 'managed', pinnedNodeIds: ['root'] };
    p.diagram = { shapes: [{ id: 'drawing', shape: 'rectangle', label: '', position: { x: 0, y: 0 }, size: { width: 500, height: 400 } }], arrows: [] };
    arrangeStudioGraph(p, sizes);
    expect(p.graph.nodes[0].position).toEqual({ x: 99, y: 99 });
    expect(p.graph.nodes[1].position).toEqual({ x: 800, y: 99 });
    expect(p.graph.nodes[2].position.y).toBeGreaterThan(400);
    const report = inspectStudioGraphLayout(p, sizes);
    expect(report.overlaps).toEqual([{ first: 'shape:drawing', second: 'root' }]);
    const saved = JSON.parse(serializeStudioProject(p));
    expect(saved.canvas.nodes[1].x).toBe(800);
    expect(saved.canvas.nodes[2].x).toBeUndefined();
  });

  it("round-trips semantic authoring without persisting computed coordinates", () => {
    const p = project(); p.graph.nodes = [node('root'), node('ticket', 'root')];
    const historyBefore = serializeStudioProjectSnapshot(p);
    arrangeStudioGraph(p, sizes);
    expect(serializeStudioProjectSnapshot(p)).toBe(historyBefore);
    const saved = serializeStudioProject(p);
    assertValidStudioProjectAgentDocumentStructure(JSON.parse(saved));
    const parsed = parseStudioProject(saved);
    expect(parsed.graph.layout?.mode).toBe('managed');
    expect(parsed.graph.nodes[1].parentId).toBe('root');
    expect(JSON.parse(saved).canvas.nodes[0]).not.toHaveProperty('x');
    expect(serializeStudioProject(parsed)).toBe(saved);
    parsed.graph.layout = { mode: 'manual' };
    expect(JSON.parse(serializeStudioProject(parsed)).canvas.nodes[0]).toHaveProperty('x');
  });

  it("rejects broken parent references, parent cycles, bad pins and invalid spacing", () => {
    const p = project(); p.graph.nodes = [node('root'), node('ticket', 'root')];
    const doc = () => JSON.parse(serializeStudioProject(p));
    const missing = doc(); missing.canvas.nodes[1].parent = 'missing';
    expect(() => assertValidStudioProjectAgentDocumentStructure(missing)).toThrow(/missing/);
    const cycle = doc(); cycle.canvas.nodes[0].parent = 'ticket';
    expect(() => assertValidStudioProjectAgentDocumentStructure(cycle)).toThrow(/cycle/);
    const pins = doc(); pins.canvas.layout.pinnedNodeIds = ['missing'];
    expect(() => assertValidStudioProjectAgentDocumentStructure(pins)).toThrow(/pinned/);
    const gap = doc(); gap.canvas.layout.rowGap = -1;
    expect(() => assertValidStudioProjectAgentDocumentStructure(gap)).toThrow(/between/);
  });

  it("reports missing measurements and bounds pathological input", () => {
    const p = project(); p.graph.nodes = [node('root')];
    expect(inspectStudioGraphLayout(p).unmeasuredNodeIds).toEqual(['root']);
    p.graph.nodes = Array.from({ length: 2501 }, (_, i) => node(String(i)));
    expect(() => arrangeStudioGraph(p)).toThrow(/2500/);
  });
});
