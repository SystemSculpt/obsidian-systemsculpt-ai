/** @jest-environment jsdom */
import { StudioAutomaticLayoutController } from "../StudioAutomaticLayoutController";
import { createEmptyStudioProject } from "../../../studio/schema";

describe("Studio measured layout lifecycle", () => {
  it('refreshes group frames when a peer grows without changing any node position', () => {
    const root=document.createElement('div');document.body.append(root);
    const project=createEmptyStudioProject({name:'Peers',policyPath:'test',minPluginVersion:'0',maxRuns:1,maxArtifactsMb:1});
    project.graph.nodes=['scout','worker'].map(id=>({id,title:id,kind:'studio.text',version:'1',position:{x:0,y:0},config:{}}));
    project.graph.groups=[{id:'roles',name:'Roles',nodeIds:['scout','worker']}];
    let height=200;
    const elements=new Map(project.graph.nodes.map(node=>{
      const el=document.createElement('div');root.append(el);
      Object.defineProperty(el,'offsetWidth',{get:()=>300});
      Object.defineProperty(el,'offsetHeight',{get:()=>node.id==='worker'?height:200});return [node.id,el] as const;
    }));
    const positionsChanged=jest.fn(),commit=jest.fn();
    const controller=new StudioAutomaticLayoutController({getProject:()=>project,getNodeElement:id=>elements.get(id)||null,isDragging:()=>false,commit,positionsChanged,reportError:jest.fn()});
    controller.mount(root);positionsChanged.mockClear();const before=project.graph.nodes.map(n=>({...n.position}));
    height=800;controller.arrange(false);
    expect(project.graph.nodes.map(n=>n.position)).toEqual(before);expect(positionsChanged).toHaveBeenCalledTimes(1);
    controller.arrange(false);expect(positionsChanged).toHaveBeenCalledTimes(1);expect(commit).not.toHaveBeenCalled();
    controller.dispose();root.remove();
  });
  it("reflows growing cards without replacing an active editor and releases observers on teardown", () => {
    jest.useFakeTimers();
    let resized: () => void = () => {};
    const disconnect = jest.fn();
    const original = window.ResizeObserver;
    window.ResizeObserver = class {
      constructor(callback: () => void) { resized = callback; }
      observe() {}
      unobserve() {}
      disconnect = disconnect;
    } as unknown as typeof ResizeObserver;
    const root = document.createElement('div'); document.body.append(root);
    const project = createEmptyStudioProject({ name: 'Measured', policyPath: 'test', minPluginVersion: '0', maxRuns: 1, maxArtifactsMb: 1 });
    project.graph.nodes = ['a', 'b'].map(id => ({ id, title: id, kind: 'studio.text', version: '1', position: { x: 0, y: 0 }, config: {} }));
    project.graph.nodes[1].parentId = 'a';
    const elements = new Map(project.graph.nodes.map(node => {
      const el = document.createElement('div'); root.append(el);
      Object.defineProperty(el, 'offsetWidth', { get: () => 300 });
      Object.defineProperty(el, 'offsetHeight', { get: () => node.id === 'a' ? height : 200 });
      return [node.id, el] as const;
    }));
    let height = 0;
    const editor = document.createElement('textarea'); elements.get('a')!.append(editor);
    const commit = jest.fn(mutator => mutator(project));
    const controller = new StudioAutomaticLayoutController({ getProject: () => project, getNodeElement: id => elements.get(id) || null,
      isDragging: () => false, commit, positionsChanged: jest.fn(), reportError: jest.fn() });
    controller.mount(root);
    expect(project.graph.nodes[1].position).toEqual({ x: 0, y: 0 });
    height = 200; resized(); jest.advanceTimersByTime(150);
    const before = project.graph.nodes[1].position.y;
    editor.focus(); editor.value = 'Unsaved editor text';
    height = 1200; resized(); jest.advanceTimersByTime(150);
    expect(project.graph.nodes[1].position.y).toBe(before);
    editor.blur(); jest.advanceTimersByTime(150);
    expect(project.graph.nodes[1].position.y).toBeGreaterThan(1200);
    expect(elements.get('a')!.querySelector('textarea')).toBe(editor);
    expect(editor.value).toBe('Unsaved editor text');
    expect(controller.inspect()?.overlaps).toEqual([]);
    expect(commit).not.toHaveBeenCalled(); // Derived coordinates do not create edits or autosave churn.
    controller.onDrag(true); project.graph.nodes[0].position.x += 60; controller.onDrag(false);
    expect(project.graph.layout?.pinnedNodeIds).toEqual(['a']);
    controller.dispose(); expect(disconnect).toHaveBeenCalled();
    height = 2500; resized(); jest.advanceTimersByTime(150);
    expect(project.graph.nodes[1].position.y).toBeLessThan(2500);
    window.ResizeObserver = original; root.remove(); jest.useRealTimers();
  });
});
