/**
 * Intelligent scoring system for search results
 */

interface ScoringContext {
  searchTerms: string[];
  originalQuery: string;
  searchPath?: string;
}

export interface ScoredResult {
  file: string;
  path: string;
  score: number;
  matchDetails: {
    keywordsFound: string[];
    keywordsMissing: string[];
    matchLocations: ('filename' | 'path' | 'content' | 'metadata' | 'graph')[];
    reasoning: string;
    entityMatches?: any[];
    semanticSimilarity?: number;
  };
  contexts?: any[];
  created?: string;
  modified?: string;
  fileSize?: number;
}

/**
 * Extract search terms from user query
 */
export function extractSearchTerms(query: string): string[] {
  // Basic extraction - split by common delimiters
  const terms = query.toLowerCase()
    .split(/[\s\-_]+/)
    .filter(term => term.length > 0);
  
  // Generate compound variations
  const variations: string[] = [];
  
  // Add original terms
  variations.push(...terms);
  
  // Add camelCase variations
  if (terms.length > 1) {
    // "license upgrade" -> "licenseUpgrade"
    variations.push(terms.map((t, i) => 
      i === 0 ? t : t.charAt(0).toUpperCase() + t.slice(1)
    ).join(''));
    
    // "license upgrade" -> "LicenseUpgrade"
    variations.push(terms.map(t => 
      t.charAt(0).toUpperCase() + t.slice(1)
    ).join(''));
  }
  
  // Add snake_case variations
  if (terms.length > 1) {
    variations.push(terms.join('_'));
  }
  
  // Add hyphenated variations
  if (terms.length > 1) {
    variations.push(terms.join('-'));
  }
  
  return [...new Set(variations)];
}

/**
 * Calculate score for a single result
 */
export function calculateScore(
  filePath: string,
  content: string | undefined,
  context: ScoringContext
): ScoredResult {
  const filename = filePath.split('/').pop() || '';
  const pathParts = filePath.toLowerCase().split('/');
  const lowerContent = content?.toLowerCase() || '';
  
  let score = 0;
  const keywordsFound: string[] = [];
  const matchLocations: ('filename' | 'path' | 'content')[] = [];
  const reasons: string[] = [];
  
  // Check each search term
  for (const term of context.searchTerms) {
    const lowerTerm = term.toLowerCase();
    let termFound = false;
    
    // Filename match (highest weight)
    if (filename.toLowerCase().includes(lowerTerm)) {
      score += 40;
      termFound = true;
      if (!matchLocations.includes('filename')) {
        matchLocations.push('filename');
      }
      reasons.push(`"${term}" in filename (+40)`);
    }
    
    // Path match (medium weight)
    if (pathParts.some(part => part.includes(lowerTerm))) {
      score += 20;
      termFound = true;
      if (!matchLocations.includes('path')) {
        matchLocations.push('path');
      }
      reasons.push(`"${term}" in path (+20)`);
    }
    
    // Content match (lower weight)
    if (lowerContent.includes(lowerTerm)) {
      score += 10;
      termFound = true;
      if (!matchLocations.includes('content')) {
        matchLocations.push('content');
      }
      reasons.push(`"${term}" in content (+10)`);
    }
    
    if (termFound && !keywordsFound.includes(term)) {
      keywordsFound.push(term);
    }
  }
  
  // Bonus for having all original query terms
  const originalTerms = context.originalQuery.toLowerCase()
    .split(/[\s\-_]+/)
    .filter(t => t.length > 0);
  
  const foundOriginalTerms = originalTerms.filter(term =>
    filename.toLowerCase().includes(term) ||
    pathParts.some(part => part.includes(term)) ||
    lowerContent.includes(term)
  );
  
  if (foundOriginalTerms.length === originalTerms.length && originalTerms.length > 1) {
    score += 30;
    reasons.push(`All original terms found (+30)`);
  }
  
  // Bonus for exact phrase match
  if (content && content.toLowerCase().includes(context.originalQuery.toLowerCase())) {
    score += 20;
    reasons.push(`Exact phrase match (+20)`);
  }
  
  // Context bonus for relevant directories
  const relevantPaths = ['email', 'campaign', 'marketing', 'draft', 'template', 'brand'];
  const pathBonus = relevantPaths.filter(rp => 
    pathParts.some(part => part.includes(rp))
  ).length * 5;
  
  if (pathBonus > 0) {
    score += pathBonus;
    reasons.push(`Relevant directory (+${pathBonus})`);
  }
  
  // Penalty for being in archive/backup/old directories
  const penaltyPaths = ['archive', 'backup', 'old', 'legacy', 'deprecated'];
  const pathPenalty = penaltyPaths.filter(pp =>
    pathParts.some(part => part.includes(pp))
  ).length * 10;
  
  if (pathPenalty > 0) {
    score -= pathPenalty;
    reasons.push(`Archive/backup directory (-${pathPenalty})`);
  }
  
  // Cap score at 100
  score = Math.min(100, Math.max(0, score));
  
  // Determine missing keywords
  const keywordsMissing = originalTerms.filter(term => 
    !keywordsFound.map(k => k.toLowerCase()).includes(term.toLowerCase())
  );
  
  return {
    file: filename,
    path: filePath,
    score,
    matchDetails: {
      keywordsFound,
      keywordsMissing,
      matchLocations,
      reasoning: reasons.join(', ')
    }
  };
}

/**
 * Sort results by score (descending)
 */
export function sortByScore(results: ScoredResult[]): ScoredResult[] {
  return results.sort((a, b) => b.score - a.score);
}

/**
 * Format results for display
 */
export function formatScoredResults(
  results: ScoredResult[],
  maxResults: number = 25
): any {
  const topResults = results.slice(0, maxResults);
  
  return {
    results: topResults.map(r => ({
      file: r.file,
      path: r.path,
      score: r.score,
      reasoning: r.matchDetails.reasoning,
      keywordsFound: r.matchDetails.keywordsFound,
      keywordsMissing: r.matchDetails.keywordsMissing,
      contexts: r.contexts,
      created: r.created,
      modified: r.modified,
      fileSize: r.fileSize
    })),
    totalFound: results.length,
    searchSummary: {
      topScore: topResults[0]?.score || 0,
      averageScore: topResults.length > 0 
        ? Math.round(topResults.reduce((sum, r) => sum + r.score, 0) / topResults.length)
        : 0,
      confidenceLevel: topResults[0]?.score >= 70 ? 'high' : 
                      topResults[0]?.score >= 40 ? 'medium' : 'low'
    }
  };
}