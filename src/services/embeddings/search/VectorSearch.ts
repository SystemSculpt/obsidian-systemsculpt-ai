/**
 * VectorSearch - presentation of a scored index record as a search result.
 *
 * Scoring itself runs over the packed per-generation matrix (SemanticMatrix);
 * this module only turns a winning record into the result shape views render.
 */

import type { EmbeddingVector, SearchResult } from "../types";

const EXCERPT_LENGTH = 200;

export function toSearchResult(record: EmbeddingVector, score: number): SearchResult {
  const rawExcerpt = record.metadata.excerpt || "";
  const excerpt = rawExcerpt.substring(0, EXCERPT_LENGTH);
  const baseExcerpt = rawExcerpt.length > EXCERPT_LENGTH ? `${excerpt}...` : excerpt;
  const sectionTitle = record.metadata.sectionTitle;
  const formattedExcerpt =
    sectionTitle && baseExcerpt && !baseExcerpt.startsWith(sectionTitle)
      ? `${sectionTitle} — ${baseExcerpt}`
      : baseExcerpt;
  return {
    path: record.path,
    score,
    chunkId: typeof record.chunkId === "number" ? record.chunkId : undefined,
    metadata: {
      title: record.metadata.title,
      excerpt: formattedExcerpt,
      lastModified: record.metadata.mtime || Date.now(),
      sectionTitle,
    },
  };
}
