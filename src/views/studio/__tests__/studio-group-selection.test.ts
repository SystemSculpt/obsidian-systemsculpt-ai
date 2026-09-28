/** @jest-environment jsdom */
import { StudioGraphInteractionEngine } from '../StudioGraphInteractionEngine';
import type { StudioProjectV1 } from '../../../studio/types';

function pointer(type: string, x=200, y=200, button=0) {
  const event=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button});
  Object.defineProperty(event,'pointerId',{value:7}); return event;
}
function harness() {
  const project={graph:{nodes:[
    {id:'inside',kind:'studio.json',position:{x:200,y:200},config:{}},
    {id:'outside',kind:'studio.json',position:{x:5000,y:5000},config:{}},
  ],edges:[],groups:[{id:'group',name:'Automation',nodeIds:['inside'],color:'#8de8bc'}]}} as unknown as StudioProjectV1;
  const commit=jest.fn((_reason,mutator) => mutator(project) !== false), clearDiagramSelection=jest.fn();
  const engine=new StudioGraphInteractionEngine({getCurrentProject:()=>project,isBusy:()=>false,setError:jest.fn(),
    recomputeEntryNodes:jest.fn(),requestRender:jest.fn(),commitProjectMutation:commit,clearDiagramSelection,
    getPortType:()=>null,portTypeCompatible:()=>true});
  const viewport=document.body.createDiv(), canvas=viewport.createDiv();
  Object.defineProperties(viewport,{clientWidth:{value:1000},clientHeight:{value:800}});
  engine.registerViewportElement(viewport); engine.registerCanvasElement(canvas);
  for(const node of project.graph.nodes){const el=canvas.createDiv({cls:'ss-studio-node-card'});el.dataset.nodeId=node.id;Object.defineProperties(el,{offsetWidth:{value:300},offsetHeight:{value:200}});engine.registerNodeElement(node.id,el);}
  engine.renderGroupLayer();
  const frame=()=>canvas.querySelector<HTMLElement>('.ss-studio-group-frame')!;
  const select=()=>{frame().dispatchEvent(pointer('pointerdown'));window.dispatchEvent(pointer('pointerup'));};
  return {engine,project,viewport,canvas,frame,select,commit,clearDiagramSelection};
}
let cleanup:()=>void=()=>{};
afterEach(()=>{cleanup();document.body.innerHTML='';});

describe('group background selection and fit',()=>{
  it('binds owner-window listeners only while a group is selected or its color palette is open',()=>{
    const bound=new Set<EventListenerOrEventListenerObject>();
    const add=window.addEventListener.bind(window), remove=window.removeEventListener.bind(window);
    jest.spyOn(window,'addEventListener').mockImplementation((type,listener,options)=>{if(type==='keydown'||type==='pointerdown')bound.add(listener);add(type,listener,options);});
    jest.spyOn(window,'removeEventListener').mockImplementation((type,listener,options)=>{if(type==='keydown'||type==='pointerdown')bound.delete(listener);remove(type,listener,options);});
    const h=harness();cleanup=()=>{h.engine.clearRenderBindings();jest.restoreAllMocks();};
    expect(bound.size).toBe(0);

    h.select();
    expect(bound.size).toBeGreaterThan(0);
    h.canvas.dispatchEvent(pointer('pointerdown'));
    expect(h.frame().getAttribute('aria-pressed')).toBe('false');
    expect(bound.size).toBe(0);

    h.canvas.querySelector<HTMLButtonElement>('.ss-studio-group-color-button')!.click();
    expect(h.canvas.querySelector('.ss-studio-group-color-palette')).not.toBeNull();
    expect(bound.size).toBeGreaterThan(0);
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    expect(h.canvas.querySelector('.ss-studio-group-color-palette')).toBeNull();
    expect(bound.size).toBe(0);

    h.select();h.engine.clearRenderBindings();
    expect(bound.size).toBe(0);
  });
  it('selects a group without moving it, clears stale member selections, and fits only its frame',()=>{
    const h=harness();cleanup=()=>h.engine.clearRenderBindings();h.engine.setSelectedNodeIds(['outside']);
    h.select();
    expect(h.frame().getAttribute('aria-pressed')).toBe('true');expect(document.activeElement).toBe(h.frame());
    expect(h.engine.getSelectedNodeIds()).toEqual([]);expect(h.clearDiagramSelection).toHaveBeenCalled();expect(h.commit).not.toHaveBeenCalled();
    expect(h.project.graph.nodes[0].position).toEqual({x:200,y:200});
    expect(h.engine.fitSelectedNodesInViewport({paddingPx:40})).toBe(true);
    expect(h.engine.getGraphZoom()).toBeGreaterThan(2);expect(h.engine.getViewportWorldTopLeft()!.x).toBeLessThan(200);
  });
  it('retains group focus on rerender, but clears it when selecting a node or empty canvas',()=>{
    const h=harness();cleanup=()=>h.engine.clearRenderBindings();h.select();h.engine.renderGroupLayer();
    expect(h.frame().getAttribute('aria-pressed')).toBe('true');
    h.engine.setSelectedNodeIds(['outside']);expect(h.frame().getAttribute('aria-pressed')).toBe('false');
    h.select();h.canvas.dispatchEvent(pointer('pointerdown'));expect(h.frame().getAttribute('aria-pressed')).toBe('false');
    expect(h.engine.fitSelectedNodesInViewport()).toBe(false);
  });
  it('leaves card interactions independent and ignores secondary-button presses',()=>{
    const h=harness();cleanup=()=>h.engine.clearRenderBindings();h.frame().dispatchEvent(pointer('pointerdown',200,200,2));
    expect(h.frame().getAttribute('aria-pressed')).toBe('false');
    h.select();const card=h.canvas.querySelector<HTMLElement>('.ss-studio-node-card')!;
    card.addEventListener('pointerdown',e=>e.stopPropagation());card.dispatchEvent(pointer('pointerdown'));
    expect(h.frame().getAttribute('aria-pressed')).toBe('false');
  });
  it.each(['Enter',' '])('supports keyboard selection with %s and resets between projects',key=>{
    const h=harness();cleanup=()=>h.engine.clearRenderBindings();h.frame().focus();
    h.frame().dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
    expect(h.frame().getAttribute('aria-pressed')).toBe('true');h.engine.clearProjectState();
    expect(h.engine.fitSelectedNodesInViewport()).toBe(false);
  });
  it('includes grouped shapes and their label in the fit even without node members',()=>{
    const h=harness();cleanup=()=>h.engine.clearRenderBindings();
    h.project.graph.groups![0].nodeIds=[];h.project.graph.groups![0].shapeIds=['shape'];
    h.project.diagram={shapes:[{id:'shape',kind:'rectangle',position:{x:200,y:200},size:{width:1200,height:500},text:'Diagram',style:{}}],arrows:[]};
    h.engine.renderGroupLayer();h.select();expect(h.engine.fitSelectedNodesInViewport({paddingPx:40})).toBe(true);
    expect(h.engine.getGraphZoom()).toBeLessThan(0.8);expect(h.engine.getGraphZoom()).toBeGreaterThan(0.5);
  });
  it.each([{ applied: false, reset: false }, { applied: true, reset: false }, { applied: false, reset: true }, { applied: true, reset: true }])('cancels group drag on teardown (frame applied: $applied, project reset: $reset)', ({ applied, reset }) => {
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++id, callback); return id; });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(handle => { frames.delete(handle); });
    const h = harness();
    cleanup = () => { h.engine.clearRenderBindings(); jest.restoreAllMocks(); };
    h.frame().dispatchEvent(pointer('pointerdown'));
    window.dispatchEvent(pointer('pointermove', 240, 250));
    if (applied) {
      for (const callback of [...frames.values()]) callback(0);
      frames.clear();
      expect(h.project.graph.nodes[0].position).toEqual({ x: 240, y: 250 });
      window.dispatchEvent(pointer('pointermove', 280, 290));
    }
    const position = { ...h.project.graph.nodes[0].position };
    if (reset) h.engine.clearProjectState(); else h.engine.clearRenderBindings();
    const count = h.commit.mock.calls.length;
    expect(frames.size).toBe(0);
    window.dispatchEvent(pointer('pointermove', 300, 320));
    window.dispatchEvent(pointer('pointerup', 300, 320));
    expect(h.commit).toHaveBeenCalledTimes(count);
    expect(h.project.graph.nodes[0].position).toEqual(position);
  });
  it('does not retain a removed group as the fit target',()=>{
    const h=harness();cleanup=()=>h.engine.clearRenderBindings();h.select();h.project.graph.groups=[];h.engine.renderGroupLayer();
    expect(h.engine.fitSelectedNodesInViewport()).toBe(false);
  });
});
