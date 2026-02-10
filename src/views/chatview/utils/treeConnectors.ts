import { errorLogger } from "../../../utils/errorLogger";

export const TREE_HEADER_SYMBOL = "+";

export type TreeConnectorThemeName = "box" | "ascii";

interface TreeConnectorTheme {
  branch: string;
  end: string;
  vertical: string;
  gap: string;
  bullet: string;
}

interface TreeLayoutDescriptor {
  lineEl: HTMLElement;
  prefixEl: HTMLElement | null;
  depth: number;
  hidden?: boolean;
}

interface TreeLayoutNode extends TreeLayoutDescriptor {
  isLast: boolean;
}

const TREE_LINE_SELECTOR = ".systemsculpt-chat-structured-line";
const TREE_PREFIX_SELECTOR = ".systemsculpt-chat-structured-line-prefix";
const TREE_WRAPPER_SELECTOR = ".systemsculpt-chat-structured-block";

const THEMES: Record<TreeConnectorThemeName, TreeConnectorTheme> = {
  box: {
    branch: "├── ",
    end: "└── ",
    vertical: "│   ",
    gap: "    ",
    bullet: "●",
  },
  ascii: {
    branch: "|- ",
    end: "`- ",
    vertical: "|  ",
    gap: "   ",
    bullet: "+",
  },
};

let activeTheme: TreeConnectorTheme = THEMES.box;

export function setTreeConnectorTheme(theme: TreeConnectorThemeName): void {
  const next = THEMES[theme];
  if (!next) return;
  activeTheme = next;
  debugLog("theme-updated", { theme });
}

export function getTreeConnectorTheme(): TreeConnectorThemeName {
  return activeTheme === THEMES.ascii ? "ascii" : "box";
}

function normalizeDepth(rawDepth: string | undefined): number {
  const parsed = Number.parseInt(rawDepth ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function isEffectivelyVisible(descriptor: TreeLayoutDescriptor): boolean {
  const { lineEl, hidden } = descriptor;
  if (!lineEl || hidden) return false;
  if (lineEl.hidden) return false;
  if (lineEl.getAttribute("hidden") !== null) return false;
  const display = lineEl.style?.display?.toLowerCase?.() ?? "";
  if (display === "none") return false;
  const ariaHidden = lineEl.getAttribute("aria-hidden");
  if (ariaHidden === "true") return false;
  if (lineEl.dataset.treeHidden === "true") return false;
  return true;
}

function computeIsLastFlags(nodes: TreeLayoutNode[]): void {
  for (let index = 0; index < nodes.length; index += 1) {
    const current = nodes[index];
    let isLast = true;
    for (let scan = index + 1; scan < nodes.length; scan += 1) {
      const next = nodes[scan];
      if (next.depth < current.depth) {
        break;
      }
      if (next.depth === current.depth && isEffectivelyVisible(next)) {
        isLast = false;
        break;
      }
    }
    current.isLast = isLast;
  }
}

function buildDescriptors(rawNodes: Array<{ lineEl: HTMLElement; prefixEl?: HTMLElement | null; depth?: number; hidden?: boolean }>): TreeLayoutDescriptor[] {
  const descriptors: TreeLayoutDescriptor[] = [];
  for (const rawNode of rawNodes) {
    const lineEl = rawNode.lineEl;
    if (!lineEl) continue;
    const prefixEl = rawNode.prefixEl ?? lineEl.querySelector<HTMLElement>(TREE_PREFIX_SELECTOR);
    if (!prefixEl) continue;
    const depth = rawNode.depth ?? normalizeDepth(lineEl.dataset.treeDepth);
    descriptors.push({ lineEl, prefixEl, depth, hidden: rawNode.hidden });
  }
  return descriptors;
}

interface ApplyLayoutOptions {
  forceEnd?: boolean;
}

function applyLayout(nodes: TreeLayoutNode[], theme: TreeConnectorTheme, options?: ApplyLayoutOptions): void {
  if (nodes.length === 0) {
    return;
  }

  computeIsLastFlags(nodes);
  const branchContinuations: boolean[] = [];

  for (const node of nodes) {
    const depthIndex = Math.max(1, node.depth);
    const parentDepthCount = depthIndex - 1;

    if (branchContinuations.length > parentDepthCount) {
      branchContinuations.length = parentDepthCount;
    }

    const segments: string[] = [];
    for (let idx = 0; idx < parentDepthCount; idx += 1) {
      segments.push(branchContinuations[idx] ? theme.vertical : theme.gap);
    }

    const isEnd = options?.forceEnd ? true : node.isLast;
    const finalSegment = isEnd ? theme.end : theme.branch;
    segments.push(finalSegment);

    if (node.prefixEl) {
      const prefix = segments.join("");
      node.prefixEl.textContent = prefix;
      node.prefixEl.dataset.treePrefix = prefix.trim();
      node.prefixEl.setAttribute("aria-hidden", "true");
      node.prefixEl.title = node.isLast ? "Last item in this tree" : "More items follow";
    }

    node.lineEl.dataset.treeConnector = isEnd ? "end" : "branch";
    node.lineEl.dataset.treeDepth = String(depthIndex);

    branchContinuations[parentDepthCount] = !isEnd && isEffectivelyVisible(node);
  }

  updateWrapperBullets(nodes, theme);
  debugLog("layout-applied", {
    nodeCount: nodes.length,
    depths: Array.from(new Set(nodes.map((node) => node.depth))).sort((a, b) => a - b),
  });
}

function updateWrapperBullets(nodes: TreeLayoutNode[], theme: TreeConnectorTheme): void {
  const wrappers = new Set<HTMLElement>();
  nodes.forEach((node) => {
    const wrapper = node.lineEl.closest<HTMLElement>(TREE_WRAPPER_SELECTOR);
    if (wrapper) wrappers.add(wrapper);
  });

  wrappers.forEach((wrapper) => {
    const bullet = wrapper.querySelector<HTMLElement>(".systemsculpt-chat-structured-bullet");
    if (!bullet) return;
    if (bullet.classList.contains("is-active") || bullet.classList.contains("is-failed")) {
      return;
    }
    if (!bullet.textContent || bullet.textContent.trim().length === 0) {
      bullet.textContent = theme.bullet;
      bullet.dataset.treePrefix = theme.bullet;
    }
  });
}

export function applyTreeLayout(
  nodes: Array<{ lineEl: HTMLElement; prefixEl?: HTMLElement | null; depth?: number; hidden?: boolean }>,
  options?: { theme?: TreeConnectorThemeName; forceEnd?: boolean }
): void {
  const theme = options?.theme ? THEMES[options.theme] ?? activeTheme : activeTheme;
  const descriptors = buildDescriptors(nodes).filter((descriptor) => isEffectivelyVisible(descriptor));
  const layoutNodes: TreeLayoutNode[] = descriptors.map((descriptor) => ({ ...descriptor, isLast: true }));
  applyLayout(layoutNodes, theme, { forceEnd: options?.forceEnd });
}

export function rebuildTreeConnectors(containerEl: HTMLElement | null, options?: { theme?: TreeConnectorThemeName }): void {
  if (!containerEl) {
    return;
  }

  const rawNodes = Array.from(containerEl.querySelectorAll<HTMLElement>(TREE_LINE_SELECTOR)).map((lineEl) => ({
    lineEl,
    prefixEl: lineEl.querySelector<HTMLElement>(TREE_PREFIX_SELECTOR),
    depth: normalizeDepth(lineEl.dataset.treeDepth),
    hidden: lineEl.dataset.treeHidden === "true",
  }));

  applyTreeLayout(rawNodes, options);
}

export function seedTreeLine(lineEl: HTMLElement | null, depth: number = 1, isLast: boolean = true, options?: { theme?: TreeConnectorThemeName }): void {
  if (!lineEl) return;
  const theme = options?.theme ? THEMES[options.theme] ?? activeTheme : activeTheme;
  const prefixEl = lineEl.querySelector<HTMLElement>(TREE_PREFIX_SELECTOR);
  const normalizedDepth = Math.max(1, depth);
  const segments: string[] = [];
  for (let idx = 1; idx < normalizedDepth; idx += 1) {
    segments.push(theme.gap);
  }
  segments.push(isLast ? theme.end : theme.branch);
  const prefix = segments.join("");
  if (prefixEl) {
    prefixEl.textContent = prefix;
    prefixEl.dataset.treePrefix = prefix.trim();
    prefixEl.setAttribute("aria-hidden", "true");
    prefixEl.title = isLast ? "Last item in this tree" : "More items follow";
  }
  lineEl.dataset.treeDepth = String(normalizedDepth);
  lineEl.dataset.treeConnector = isLast ? "end" : "branch";
}

export function setBulletSymbol(bulletEl: HTMLElement | null, symbol: string): void {
  if (!bulletEl) {
    return;
  }

  bulletEl.textContent = symbol;
  bulletEl.dataset.treePrefix = symbol.trim();
}

function debugLog(event: string, metadata: Record<string, unknown>): void {
  try {
    errorLogger.debug("Tree connectors", {
      source: "TreeConnectors",
      method: event,
      metadata,
    });
  } catch {
    // swallow logging errors to avoid cascading failures
  }
}
