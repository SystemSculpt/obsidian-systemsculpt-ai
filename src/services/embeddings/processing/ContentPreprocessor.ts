import { TFile } from "obsidian";

export interface ProcessedContent {
  content: string;
  hash: string;
  length: number;
  excerpt?: string;
  /**
   * Source text with structure preserved (normalized, front-matter stripped).
   * Used for chunking so we can retain heading context.
   */
  source?: string;
}

export interface PreparedChunk {
  index: number;
  text: string;
  hash: string;
  headingPath: string[];
  length: number;
}

interface ParagraphBlock {
  text: string;
  headingTrail: string[];
}

/**
 * ContentPreprocessor - Intelligent content preparation
 *
 * Prepares content for embedding generation:
 * - Removes unnecessary formatting
 * - Extracts meaningful text while preserving structure
 * - Generates content hashes for deduplication
 * - Optimizes chunk size with controlled overlap
 */
export class ContentPreprocessor {
  private readonly MIN_CONTENT_LENGTH = 80;
  private readonly HARD_TRUNCATE_LENGTH = 1_200_000; // Safety ceiling ~1.2M characters

  private readonly TARGET_TOKEN_LENGTH = 600;
  private readonly AVG_CHARS_PER_TOKEN = 4;
  private readonly TARGET_CHARS = this.TARGET_TOKEN_LENGTH * this.AVG_CHARS_PER_TOKEN; // ≈2.4k chars
  private readonly MAX_CHARS = Math.round(this.TARGET_CHARS * 1.35); // ≈3.2k chars
  private readonly MIN_CHARS = Math.round(this.TARGET_CHARS * 0.5); // ≈1.2k chars
  private readonly OVERLAP_RATIO = 0.2; // 20% overlap between adjacent long chunks

  /**
   * Process file content for embedding
   */
  process(content: string, _file: TFile): ProcessedContent | null {
    const normalized = this.normalizeLineEndings(this.stripFrontMatter(content));
    const cleaned = this.cleanContent(normalized);

    if (cleaned.length < this.MIN_CONTENT_LENGTH) {
      return null;
    }

    const truncated =
      cleaned.length > this.HARD_TRUNCATE_LENGTH
        ? this.smartTruncate(cleaned, this.HARD_TRUNCATE_LENGTH)
        : cleaned;

    const hash = this.generateHash(truncated);

    return {
      content: truncated,
      hash,
      length: truncated.length,
      excerpt: truncated.substring(0, 240),
      source: normalized,
    };
  }

  /**
   * Clean content for embedding while preserving structural markers.
   */
  private cleanContent(content: string): string {
    let result = content;

    // Remove image embeds entirely
    result = result.replace(/!\[\[.*?\]\]/g, " ");
    result = result.replace(/!\[[^\]]*?\]\([^)]*?\)/g, " ");

    // Replace wiki links with display text
    result = result.replace(/\[\[([^\|\]]+)\|([^\]]+)\]\]/g, "$2");
    result = result.replace(/\[\[([^\]]+)\]\]/g, "$1");
    // Replace markdown links with text
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");

    // Strip code fences but leave inner content
    result = result.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, inner: string) => {
      return this.normalizeWhitespace(inner);
    });

    // Strip inline code markers
    result = result.replace(/`([^`]+)`/g, "$1");

    // Remove horizontal rules
    result = result.replace(/^-{3,}$/gm, "");
    result = result.replace(/^_{3,}$/gm, "");
    result = result.replace(/^\*{3,}$/gm, "");

    // Remove heading markers but keep their text on separate lines
    result = result.replace(/^\s*#{1,6}\s+/gm, "");

    // Collapse excess blank lines
    result = result.replace(/\r/g, "");
    result = result.replace(/[ \t]+\n/g, "\n");
    result = result.replace(/\n{3,}/g, "\n\n");

    // Normalise whitespace without destroying paragraph breaks
    result = this.normalizeWhitespace(result);

    return result.trim();
  }

  /**
   * Smart truncation that respects sentence boundaries
   */
  private smartTruncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;

    const truncated = text.substring(0, maxLength);
    const boundary = this.findBackwardBoundary(truncated);
    if (boundary > maxLength * 0.8) {
      return truncated.substring(0, boundary).trim();
    }

    const lastSpace = truncated.lastIndexOf(" ");
    if (lastSpace > maxLength * 0.7) {
      return truncated.substring(0, lastSpace).trim();
    }

    return truncated.trim();
  }

  private findBackwardBoundary(text: string): number {
    const reversed = text.split("").reverse().join("");
    const match = reversed.match(/([.!?]\s)/);
    if (!match || match.index === undefined) return -1;
    return text.length - match.index - match[0].length + 1;
  }

  /**
   * Generate content hash (fast, non-cryptographic)
   */
  private generateHash(content: string): string {
    let hash = 2166136261;
    for (let i = 0; i < content.length; i++) {
      hash ^= content.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(36);
  }

  /**
   * Split content into chunks for large files based on structured paragraphs.
   */
  chunkContent(content: string, source?: string): string[] {
    return this.chunkContentWithHashes(content, source).map((chunk) => chunk.text);
  }

  /**
   * Split content into chunks and include stable content hashes per chunk.
   * This enables incremental embedding updates by reusing unchanged chunk vectors.
   */
  chunkContentWithHashes(content: string, source?: string): PreparedChunk[] {
    const reference = (source ?? content).trim();
    if (!reference) return [];

    const paragraphs = this.buildParagraphs(reference);
    const structured = paragraphs.length > 0 ? paragraphs : [{ text: content.trim(), headingTrail: [] }];
    const assembled = this.assembleChunks(structured);

    const result: PreparedChunk[] = [];
    assembled.forEach((chunk, idx) => {
      const text = chunk.text.trim();
      if (!text) return;
      result.push({
        index: idx,
        text,
        hash: this.generateHash(text),
        headingPath: chunk.headingTrail.filter((h) => !!h),
        length: text.length,
      });
    });

    return result;
  }

  private normalizeLineEndings(content: string): string {
    return content.replace(/\r\n?/g, "\n");
  }

  private stripFrontMatter(content: string): string {
    if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
      const closing = content.indexOf("\n---", 3);
      if (closing !== -1) {
        const end = closing + 4;
        return content.slice(end);
      }
    }
    return content;
  }

  private normalizeWhitespace(text: string): string {
    return text
      .replace(/[ \t]+/g, " ")
      .replace(/ \n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n");
  }

  private buildParagraphs(source: string): ParagraphBlock[] {
    const lines = source.split("\n");
    const paragraphs: ParagraphBlock[] = [];
    let buffer: string[] = [];
    let headingTrail: Array<{ level: number; text: string }> = [];

    const flush = () => {
      if (buffer.length === 0) return;
      const raw = buffer.join(" ").trim();
      buffer = [];
      const cleaned = this.cleanParagraph(raw);
      if (!cleaned) return;
      paragraphs.push({
        text: cleaned,
        headingTrail: headingTrail.map((h) => h.text),
      });
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        flush();
        continue;
      }

      const headingMatch = rawLine.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        flush();
        const level = headingMatch[1].length;
        const headingText = this.cleanHeading(headingMatch[2]);
        headingTrail = headingTrail.slice(0, level - 1);
        headingTrail[level - 1] = { level, text: headingText };
        continue;
      }

      const listMatch = rawLine.match(/^\s*[-*+]\s+(.*)$/);
      if (listMatch) {
        buffer.push(listMatch[1]);
        continue;
      }

      const orderedMatch = rawLine.match(/^\s*\d+\.\s+(.*)$/);
      if (orderedMatch) {
        buffer.push(orderedMatch[1]);
        continue;
      }

      buffer.push(rawLine);
    }

    flush();
    return paragraphs;
  }

  private cleanParagraph(paragraph: string): string {
    if (!paragraph) return "";
    let result = paragraph;
    result = result.replace(/!\[\[.*?\]\]/g, " ");
    result = result.replace(/!\[[^\]]*?\]\([^)]*?\)/g, " ");
    result = result.replace(/\[\[([^\|\]]+)\|([^\]]+)\]\]/g, "$2");
    result = result.replace(/\[\[([^\]]+)\]\]/g, "$1");
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
    result = result.replace(/`([^`]+)`/g, "$1");
    result = result.replace(/\*\*(.*?)\*\*/g, "$1");
    result = result.replace(/\*(.*?)\*/g, "$1");
    result = result.replace(/_{1,2}(.*?)_{1,2}/g, "$1");
    result = result.replace(/~~(.*?)~~/g, "$1");
    result = result.replace(/<[^>]+>/g, " ");
    result = result.replace(/\|\|/g, " ");
    result = result.replace(/\s+/g, " ");
    return result.trim();
  }

  private cleanHeading(heading: string): string {
    return this.cleanParagraph(heading).replace(/:+\s*$/, "");
  }

  private assembleChunks(paragraphs: ParagraphBlock[]): ParagraphBlock[] {
    if (paragraphs.length === 0) return [];

    const chunks: ParagraphBlock[] = [];
    let currentText = "";
    let currentHeading: string[] = [];

    const pushChunk = (text: string, headingTrail: string[]) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (trimmed.length > this.MAX_CHARS) {
        const splitChunks = this.splitWithOverlap(trimmed).map((piece) => ({
          text: piece,
          headingTrail,
        }));
        chunks.push(...splitChunks);
      } else {
        chunks.push({ text: trimmed, headingTrail });
      }
    };

    paragraphs.forEach((paragraph, idx) => {
      const addition = paragraph.text;
      if (!addition) return;

      if (!currentText) {
        currentText = addition;
        currentHeading = paragraph.headingTrail;
        if (idx === paragraphs.length - 1) {
          pushChunk(currentText, currentHeading);
          currentText = "";
        }
        return;
      }

      const candidate = `${currentText}\n\n${addition}`;
      if (candidate.length <= this.MAX_CHARS) {
        currentText = candidate;
      } else {
        const shouldFlushCurrent = currentText.length >= this.MIN_CHARS;
        if (shouldFlushCurrent) {
          pushChunk(currentText, currentHeading);
          currentText = addition;
          currentHeading = paragraph.headingTrail;
        } else {
          // Current chunk is tiny; combine and split aggressively
          const forced = this.splitWithOverlap(candidate);
          const trail = paragraph.headingTrail.length > 0 ? paragraph.headingTrail : currentHeading;
          forced.forEach((piece) => {
            pushChunk(piece, trail);
          });
          currentText = "";
        }
      }

      const reachedTarget = currentText.length >= this.TARGET_CHARS;
      const hasMore = idx < paragraphs.length - 1;
      if (reachedTarget && hasMore) {
        pushChunk(currentText, currentHeading);
        currentText = "";
      }

      if (!hasMore && currentText) {
        pushChunk(currentText, currentHeading);
        currentText = "";
      }
    });

    if (currentText) {
      pushChunk(currentText, currentHeading);
    }

    return this.mergeTinyTrailingChunks(chunks);
  }

  private splitWithOverlap(text: string): string[] {
    if (text.length <= this.MAX_CHARS) return [text.trim()];

    const target = this.TARGET_CHARS;
    const overlap = Math.max(120, Math.floor(target * this.OVERLAP_RATIO));
    const pieces: string[] = [];
    let start = 0;

    while (start < text.length) {
      let end = Math.min(text.length, start + target);
      if (end < text.length) {
        const forwardBoundary = this.findForwardBoundary(text, end);
        if (forwardBoundary > end && forwardBoundary - start <= this.MAX_CHARS) {
          end = forwardBoundary;
        }
      }

      const chunk = text.slice(start, end).trim();
      if (chunk) pieces.push(chunk);
      if (end >= text.length) break;
      start = Math.max(end - overlap, start + 1);
    }

    return pieces;
  }

  private findForwardBoundary(text: string, index: number): number {
    const window = text.slice(index, Math.min(text.length, index + 200));
    const match = window.match(/([.!?])\s/);
    if (!match || match.index === undefined) {
      return index;
    }
    return index + match.index + 1;
  }

  private mergeTinyTrailingChunks(chunks: ParagraphBlock[]): ParagraphBlock[] {
    if (chunks.length <= 1) return chunks;

    const merged: ParagraphBlock[] = [];
    for (const chunk of chunks) {
      if (
        merged.length > 0 &&
        chunk.text.length < 180 &&
        (merged[merged.length - 1].text.length + chunk.text.length + 2) <= this.MAX_CHARS
      ) {
        const previous = merged[merged.length - 1];
        previous.text = `${previous.text}\n\n${chunk.text}`.trim();
        continue;
      }
      merged.push(chunk);
    }
    return merged;
  }
}
