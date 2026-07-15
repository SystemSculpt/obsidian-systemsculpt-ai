export type StudioTextNodeFocusTarget = {
  x: number;
  y: number;
  /** Exact Markdown document offset resolved from the rendered preview. */
  sourceOffset?: number;
};

type SourceLine = {
  text: string;
  start: number;
  end: number;
};

type SourceRange = {
  start: number;
  end: number;
};

type AlignedSource = {
  text: string;
  /** Raw-source index for each UTF-16 code unit in the aligned text. */
  sourceIndices: number[];
};

type SourceBlock = {
  tag: string;
  range: SourceRange;
  content?: SourceRange;
  tableRows?: SourceLine[];
  listItems?: SourceRange[];
};

type CaretPositionDocument = Document & {
  caretPositionFromPoint?: (
    x: number,
    y: number
  ) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

const HEADING_PATTERN = /^ {0,3}(#{1,6})[\t ]+(.*)$/;
const LIST_ITEM_PATTERN = /^(\s*)([-+*]|\d+[.)])[\t ]+(.*)$/;
const TABLE_SEPARATOR_CELL_PATTERN = /^:?-{3,}:?$/;

function readSourceLines(markdown: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (const text of markdown.split("\n")) {
    const end = start + text.length;
    lines.push({ text, start, end });
    start = end + 1;
  }
  return lines;
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function splitTableCellRanges(line: SourceLine): SourceRange[] {
  const boundaries: number[] = [];
  for (let index = 0; index < line.text.length; index += 1) {
    if (line.text[index] === "|" && !isEscaped(line.text, index)) {
      boundaries.push(index);
    }
  }
  const segments: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const boundary of boundaries) {
    segments.push({ start, end: boundary });
    start = boundary + 1;
  }
  segments.push({ start, end: line.text.length });

  const first = segments[0];
  if (
    segments.length > 1
    && first
    && line.text.slice(first.start, first.end).trim() === ""
  ) {
    segments.shift();
  }
  const last = segments[segments.length - 1];
  if (
    segments.length > 1
    && last
    && line.text.slice(last.start, last.end).trim() === ""
  ) {
    segments.pop();
  }

  return segments.map((segment) => {
    const raw = line.text.slice(segment.start, segment.end);
    const leading = raw.match(/^\s*/)?.[0].length ?? 0;
    const trailing = raw.match(/\s*$/)?.[0].length ?? 0;
    return {
      start: line.start + segment.start + leading,
      end: Math.max(
        line.start + segment.start + leading,
        line.start + segment.end - trailing
      ),
    };
  });
}

function isTableSeparator(line: string): boolean {
  const sourceLine: SourceLine = { text: line, start: 0, end: line.length };
  const cells = splitTableCellRanges(sourceLine);
  return (
    cells.length > 0 &&
    cells.every((cell) =>
      TABLE_SEPARATOR_CELL_PATTERN.test(line.slice(cell.start, cell.end).trim())
    )
  );
}

function looksLikeTableStart(lines: SourceLine[], index: number): boolean {
  return Boolean(
    lines[index]?.text.includes("|") &&
      lines[index + 1]?.text.includes("|") &&
      isTableSeparator(lines[index + 1].text)
  );
}

function looksLikeFence(line: string): { marker: string } | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
  return match ? { marker: match[1] } : null;
}

function startsStandaloneBlock(lines: SourceLine[], index: number): boolean {
  const line = lines[index]?.text ?? "";
  return Boolean(
    !line.trim() ||
      looksLikeFence(line) ||
      HEADING_PATTERN.test(line) ||
      LIST_ITEM_PATTERN.test(line) ||
      looksLikeTableStart(lines, index)
  );
}

function parseSourceBlocks(markdown: string): SourceBlock[] {
  const lines = readSourceLines(markdown);
  const blocks: SourceBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.text.trim()) {
      index += 1;
      continue;
    }

    const fence = looksLikeFence(line.text);
    if (fence) {
      const markerChar = fence.marker[0];
      const markerLength = fence.marker.length;
      let closeIndex = index + 1;
      while (closeIndex < lines.length) {
        const candidate = lines[closeIndex].text.match(/^ {0,3}(`{3,}|~{3,})\s*$/)?.[1];
        if (
          candidate &&
          candidate[0] === markerChar &&
          candidate.length >= markerLength
        ) {
          break;
        }
        closeIndex += 1;
      }
      const contentStart = Math.min(markdown.length, line.end + 1);
      const contentEnd =
        closeIndex < lines.length ? lines[closeIndex].start : markdown.length;
      const blockEnd =
        closeIndex < lines.length ? lines[closeIndex].end : markdown.length;
      blocks.push({
        tag: "PRE",
        range: { start: line.start, end: blockEnd },
        content: { start: contentStart, end: contentEnd },
      });
      index = closeIndex < lines.length ? closeIndex + 1 : lines.length;
      continue;
    }

    const heading = line.text.match(HEADING_PATTERN);
    if (heading) {
      const headingPrefix = line.text.match(/^ {0,3}#{1,6}[\t ]+/)?.[0] ?? "";
      const contentStart = line.start + headingPrefix.length;
      blocks.push({
        tag: `H${heading[1].length}`,
        range: { start: line.start, end: line.end },
        content: { start: contentStart, end: line.end },
      });
      index += 1;
      continue;
    }

    if (looksLikeTableStart(lines, index)) {
      const tableLines: SourceLine[] = [line];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].text.trim() && lines[cursor].text.includes("|")) {
        tableLines.push(lines[cursor]);
        cursor += 1;
      }
      blocks.push({
        tag: "TABLE",
        range: {
          start: line.start,
          end: lines[Math.max(index + 1, cursor - 1)].end,
        },
        tableRows: tableLines,
      });
      index = cursor;
      continue;
    }

    const listMatch = line.text.match(LIST_ITEM_PATTERN);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[2]);
      const baseIndent = listMatch[1].length;
      const items: SourceRange[] = [];
      let cursor = index;
      while (cursor < lines.length) {
        const currentLine = lines[cursor];
        if (!currentLine.text.trim()) {
          break;
        }
        const item = currentLine.text.match(LIST_ITEM_PATTERN);
        if (!item) {
          if (startsStandaloneBlock(lines, cursor)) {
            break;
          }
          cursor += 1;
          continue;
        }
        const itemIndent = item[1].length;
        if (itemIndent <= baseIndent && /^\d/.test(item[2]) !== ordered) {
          break;
        }
        const itemLine = currentLine;
        let contentStart = itemLine.start + itemLine.text.indexOf(item[3]);
        const taskPrefix = item[3].match(/^\[[ xX]\][\t ]*/)?.[0];
        if (taskPrefix) {
          contentStart += taskPrefix.length;
        }
        let itemEndCursor = cursor + 1;
        while (itemEndCursor < lines.length) {
          const nextLine = lines[itemEndCursor];
          if (!nextLine.text.trim()) {
            break;
          }
          const nextItem = nextLine.text.match(LIST_ITEM_PATTERN);
          if (nextItem) {
            if (nextItem[1].length <= itemIndent) {
              break;
            }
          } else if (startsStandaloneBlock(lines, itemEndCursor)) {
            break;
          }
          itemEndCursor += 1;
        }
        items.push({ start: contentStart, end: lines[itemEndCursor - 1].end });
        cursor += 1;
      }
      blocks.push({
        tag: ordered ? "OL" : "UL",
        range: { start: line.start, end: lines[cursor - 1].end },
        listItems: items,
      });
      index = cursor;
      continue;
    }

    let cursor = index + 1;
    while (cursor < lines.length && !startsStandaloneBlock(lines, cursor)) {
      cursor += 1;
    }
    blocks.push({
      tag: "P",
      range: { start: line.start, end: lines[cursor - 1].end },
      content: { start: line.start, end: lines[cursor - 1].end },
    });
    index = cursor;
  }
  return blocks;
}

function resolveRenderedTextOffset(
  element: HTMLElement,
  x: number,
  y: number
): number | undefined {
  const document = element.ownerDocument as CaretPositionDocument;
  const caretPosition = document.caretPositionFromPoint?.(x, y);
  const caretRange = caretPosition
    ? { node: caretPosition.offsetNode, offset: caretPosition.offset }
    : (() => {
        const range = document.caretRangeFromPoint?.(x, y);
        return range
          ? { node: range.startContainer, offset: range.startOffset }
          : null;
      })();
  if (caretRange && element.contains(caretRange.node)) {
    const before = document.createRange();
    before.selectNodeContents(element);
    try {
      before.setEnd(caretRange.node, caretRange.offset);
      return before.toString().length;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function alignWikiAliases(raw: string): AlignedSource | undefined {
  let text = "";
  const sourceIndices: number[] = [];
  let cursor = 0;
  let matchedWiki = false;
  const appendRaw = (start: number, end: number): void => {
    text += raw.slice(start, end);
    for (let index = start; index < end; index += 1) {
      sourceIndices.push(index);
    }
  };

  for (const match of raw.matchAll(/(!?)\[\[([^\]\n]*)\]\]/g)) {
    const start = match.index;
    if (start === undefined) {
      continue;
    }
    matchedWiki = true;
    if (match[1] === "!") {
      // Embedded notes/images replace the token with an unrelated surface.
      return undefined;
    }
    if (raw.slice(cursor, start).includes("[[")) {
      return undefined;
    }
    appendRaw(cursor, start);
    const inner = match[2];
    if (inner.includes("[[")) {
      return undefined;
    }
    // Within Markdown tables Obsidian requires the alias delimiter to be
    // escaped (`\|`); it is still a wiki-alias delimiter, not literal text.
    const aliasSeparator = inner.indexOf("|");
    if (aliasSeparator < 0) {
      // Simple unaliased targets render verbatim. Paths and subpaths have
      // host-specific labels, so leave those to the mounted editor.
      if (/[\/#^]/.test(inner)) {
        return undefined;
      }
      const targetStart = start + 2;
      appendRaw(targetStart, targetStart + inner.length);
    } else {
      const alias = inner.slice(aliasSeparator + 1);
      if (!alias) {
        return undefined;
      }
      const aliasStart = start + 2 + aliasSeparator + 1;
      appendRaw(aliasStart, aliasStart + alias.length);
    }
    cursor = start + match[0].length;
  }
  if (
    (raw.includes("[[") && !matchedWiki)
    || raw.slice(cursor).includes("[[")
  ) {
    return undefined;
  }
  appendRaw(cursor, raw.length);
  return { text, sourceIndices };
}

function renderedOffsetToSourceOffset(
  markdown: string,
  range: SourceRange,
  renderedText: string,
  renderedOffset: number
): number | undefined {
  const raw = markdown.slice(range.start, range.end);
  if (!renderedText) {
    return raw ? undefined : range.start;
  }
  // Entities and inline HTML transform text in ways that cannot be aligned
  // monotonically by the lightweight syntax-skipping matcher.
  if (
    /<[A-Za-z!/][^>]*>|&(?:#[xX]?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);/.test(raw)
  ) {
    return undefined;
  }
  const aligned = alignWikiAliases(raw);
  if (!aligned) {
    return undefined;
  }
  const alignableText = aligned.text;
  const boundedOffset = Math.max(0, Math.min(renderedText.length, renderedOffset));
  let rawCursor = 0;
  let lastMatch = -1;
  let clickedMatch = -1;
  for (let renderedCursor = 0; renderedCursor < renderedText.length; renderedCursor += 1) {
    const renderedChar = renderedText[renderedCursor];
    let match = -1;
    for (let candidate = rawCursor; candidate < alignableText.length; candidate += 1) {
      const rawChar = alignableText[candidate];
      if (
        rawChar === renderedChar ||
        (/\s/.test(rawChar) && /\s/.test(renderedChar))
      ) {
        match = candidate;
        break;
      }
    }
    if (match < 0) {
      return undefined;
    }
    if (renderedCursor === boundedOffset) {
      clickedMatch = match;
    }
    lastMatch = match;
    rawCursor = match + 1;
  }
  if (boundedOffset < renderedText.length && clickedMatch >= 0) {
    return range.start + aligned.sourceIndices[clickedMatch];
  }
  if (boundedOffset >= renderedText.length && lastMatch >= 0) {
    return range.start + aligned.sourceIndices[lastMatch] + 1;
  }
  const remainingSourceIndex =
    rawCursor < aligned.sourceIndices.length
      ? aligned.sourceIndices[rawCursor]
      : raw.length;
  return Math.max(
    range.start,
    Math.min(range.end, range.start + remainingSourceIndex)
  );
}

function findTopLevelBlock(
  displayEl: HTMLElement,
  target: EventTarget | null
): HTMLElement | null {
  if (!(target instanceof displayEl.ownerDocument.defaultView!.Element)) {
    return null;
  }
  let element = target as HTMLElement;
  while (element.parentElement && element.parentElement !== displayEl) {
    element = element.parentElement;
  }
  return element.parentElement === displayEl ? element : null;
}

function resolveSemanticSourceOffset(
  markdown: string,
  displayEl: HTMLElement,
  target: EventTarget | null,
  x: number,
  y: number
): number | undefined {
  const blockEl = findTopLevelBlock(displayEl, target);
  if (!blockEl) {
    return undefined;
  }
  const blockIndex = Array.from(displayEl.children).indexOf(blockEl);
  const block = parseSourceBlocks(markdown)[blockIndex];
  if (!block || block.tag !== blockEl.tagName) {
    return undefined;
  }

  if (block.tag === "TABLE") {
    const targetEl = target as Element;
    const cell = targetEl.closest("th, td") as HTMLTableCellElement | null;
    const row = cell?.parentElement as HTMLTableRowElement | null;
    const sourceLine = row ? block.tableRows?.[row.rowIndex] : undefined;
    const sourceCell = sourceLine
      ? splitTableCellRanges(sourceLine)[cell?.cellIndex ?? -1]
      : undefined;
    if (!cell || !sourceCell) {
      return undefined;
    }
    const renderedOffset = resolveRenderedTextOffset(cell, x, y);
    if (renderedOffset === undefined) {
      return undefined;
    }
    return renderedOffsetToSourceOffset(
      markdown,
      sourceCell,
      cell.textContent ?? "",
      renderedOffset
    );
  }

  if (block.tag === "UL" || block.tag === "OL") {
    const targetEl = target as Element;
    const item = targetEl.closest("li") as HTMLLIElement | null;
    const itemIndex = item ? Array.from(blockEl.querySelectorAll("li")).indexOf(item) : -1;
    const sourceItem = itemIndex >= 0 ? block.listItems?.[itemIndex] : undefined;
    if (!item || !sourceItem) {
      return undefined;
    }
    const renderedOffset = resolveRenderedTextOffset(item, x, y);
    if (renderedOffset === undefined) {
      return undefined;
    }
    return renderedOffsetToSourceOffset(
      markdown,
      sourceItem,
      item.textContent ?? "",
      renderedOffset
    );
  }

  const content = block.content ?? block.range;
  const textElement =
    block.tag === "PRE"
      ? blockEl.querySelector<HTMLElement>("code") ?? blockEl
      : blockEl;
  const renderedOffset = resolveRenderedTextOffset(textElement, x, y);
  if (renderedOffset === undefined) {
    return undefined;
  }
  return renderedOffsetToSourceOffset(
    markdown,
    content,
    textElement.textContent ?? "",
    renderedOffset
  );
}

export function resolveStudioTextNodeFocusTarget(
  markdown: string,
  displayEl: HTMLElement,
  event: MouseEvent
): StudioTextNodeFocusTarget {
  const target: StudioTextNodeFocusTarget = {
    x: event.clientX,
    y: event.clientY,
  };
  const sourceOffset = resolveSemanticSourceOffset(
    markdown,
    displayEl,
    event.target,
    event.clientX,
    event.clientY
  );
  if (typeof sourceOffset === "number" && Number.isFinite(sourceOffset)) {
    target.sourceOffset = Math.max(0, Math.min(markdown.length, Math.round(sourceOffset)));
  }
  return target;
}
