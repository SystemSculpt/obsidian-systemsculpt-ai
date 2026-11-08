/** @jest-environment jsdom */
import { StudioCanvasSelection } from "../StudioCanvasSelection";

it("keeps mixed node, shape and arrow picks in one selection and focuses groups exclusively", () => {
  const selection = new StudioCanvasSelection();
  const changes = jest.fn();
  const unsubscribe = selection.subscribe(changes);
  selection.replace("node", ["n1", "n2"]);
  selection.toggle("shape", "s1");
  selection.toggle("arrow", "a1");
  expect([...selection.ids("node")]).toEqual(["n1", "n2"]);
  expect([...selection.ids("shape")]).toEqual(["s1"]);
  expect([...selection.ids("arrow")]).toEqual(["a1"]);

  selection.selectOnly("group", "g1");
  expect([...selection.ids("group")]).toEqual(["g1"]);
  for (const kind of ["node", "shape", "arrow"] as const) expect(selection.ids(kind).size).toBe(0);
  selection.replace("node", ["n3"]);
  expect(selection.ids("group").size).toBe(0);
  expect([...selection.ids("node")]).toEqual(["n3"]);
  expect(changes).toHaveBeenCalledTimes(5);
  unsubscribe();
  selection.clear();
  expect(changes).toHaveBeenCalledTimes(5);
});

it("ignores unchanged picks and keeps kinds distinct when their IDs match", () => {
  const selection = new StudioCanvasSelection();
  const changes = jest.fn();
  selection.subscribe(changes);
  selection.replace("node", ["same", " same ", ""]);
  selection.replace("node", ["same"]);
  selection.replace("shape", ["same"]);
  selection.remove("node", "same");
  expect([...selection.ids("shape")]).toEqual(["same"]);
  expect(changes).toHaveBeenCalledTimes(3);
  selection.selectOnly("arrow", "same");
  expect(selection.ids("shape").size).toBe(0);
  expect([...selection.ids("arrow")]).toEqual(["same"]);
});
