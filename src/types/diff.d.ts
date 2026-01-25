declare module "diff" {
  // We only use a few helper functions (`applyPatch`, `createPatch`).
  // Typing them as `any` is sufficient for now and avoids pulling additional
  // dependencies. If stricter typing is desired later we can switch to
  // `@types/diff` once it exists or write a full declaration.
  const _diff: any;
  export = _diff;
} 