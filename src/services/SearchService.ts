export interface SearchableField {
  field: string;
  text: string | null | undefined;
  weight: number;
}

export interface SearchMatch {
  field: string;
  text: string;
  indices: number[];
  matchQuality: number;
}

export interface SearchResult<T> {
  item: T;
  matches: SearchMatch[];
  score: number;
}

export interface SearchUIOptions<T> {
  containerEl: HTMLElement;
  placeholder?: string;
  getItemTitle: (item: T) => string;
  getItemDescription?: (item: T) => string;
  getItemBadge?: (item: T) => string;
  getItemContext?: (item: T) => string;
  getItemMeta?: (item: T) => string;
  onSelect: (item: T) => void;
  initialQuery?: string;
  initialResultsLimit?: number;
  maxFilteredResults?: number;
  emptyStateText?: string;
  isLoading?: boolean;
  loadingStateText?: string;
}

export interface FlattenedSearchItem<T> {
  item: T;
  searchText: string;
  fieldWeights: Map<string, number>;
}

export class SearchService {
  private readonly DEFAULT_INITIAL_RESULTS_LIMIT = 25;
  private readonly DEFAULT_MAX_FILTERED_RESULTS = 50;
  private static instance: SearchService;
  
  /**
   * Get the SearchService instance (singleton)
   */
  public static getInstance(): SearchService {
    if (!SearchService.instance) {
      SearchService.instance = new SearchService();
    }
    return SearchService.instance;
  }

  public search<T>(
    items: T[],
    query: string,
    getSearchableFields: (item: T) => SearchableField[],
    options?: { initialResultsLimit?: number; maxFilteredResults?: number }
  ): SearchResult<T>[] {
    const initialLimit = options?.initialResultsLimit ?? this.DEFAULT_INITIAL_RESULTS_LIMIT;
    const maxFiltered = options?.maxFilteredResults ?? this.DEFAULT_MAX_FILTERED_RESULTS;

    // If no query, return initial items with no matches
    if (!query.trim()) {
      return items.slice(0, initialLimit).map((item) => ({
        item,
        matches: [],
        score: 0,
      }));
    }

    // Split query into terms and normalize
    const searchTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
    
    // Fast search using flattened structure
    const results = items.map(item => {
      const fields = getSearchableFields(item);
      const matches: SearchMatch[] = [];
      let totalScore = 0;

      // Combine all searchable text with field weights
      const searchText = fields.map(f => f.text?.toLowerCase() || '').join(' ');
      
      // Quick check if all terms exist
      const allTermsExist = searchTerms.every(term => searchText.includes(term));
      if (!allTermsExist) {
        return { item, matches: [], score: 0 };
      }

      // Find matches and calculate score
      searchTerms.forEach(term => {
        let pos = 0;
        const termMatches = new Set<number>();
        
        while ((pos = searchText.indexOf(term, pos)) !== -1) {
          // Find which field this match belongs to
          let currentPos = 0;
          for (const field of fields) {
            const fieldText = field.text?.toLowerCase() || '';
            const fieldEnd = currentPos + fieldText.length;
            
            if (pos >= currentPos && pos < fieldEnd) {
              // Match is in this field
              const relativePos = pos - currentPos;
              const quality = this.getMatchQuality(fieldText, term, relativePos);
              
              matches.push({
                field: field.field,
                text: field.text || '',
                indices: Array.from({ length: term.length }, (_, i) => relativePos + i),
                matchQuality: quality
              });
              
              totalScore += field.weight * quality;
              break;
            }
            currentPos = fieldEnd + 1; // +1 for the space we added between fields
          }
          pos += 1;
        }
      });

      // Add proximity bonus for multiple terms
      if (searchTerms.length > 1 && matches.length > 0) {
        const positions = matches.flatMap(m => m.indices[0]);
        const maxDistance = Math.max(...positions) - Math.min(...positions);
        if (maxDistance < 50) {
          totalScore *= 1.5;
        }
      }

      return {
        item,
        matches,
        score: totalScore
      };
    });

    // Filter and sort results
    return results
      .filter(result => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxFiltered);
  }

  private getMatchQuality(text: string, term: string, position: number): number {
    // Check if this is a word boundary match
    const beforeChar = position > 0 ? text[position - 1] : ' ';
    const afterChar = position + term.length < text.length ? text[position + term.length] : ' ';
    
    if ((/\s/.test(beforeChar) || /\W/.test(beforeChar)) && 
        (/\s/.test(afterChar) || /\W/.test(afterChar))) {
      return 1.0; // Perfect word boundary match
    }
    
    return 0.8; // Partial match
  }

  public highlightText(text: string, matches: SearchMatch[] = [], searchQuery?: string): DocumentFragment {
    if (!matches || matches.length === 0 || !searchQuery) {
      const fragment = document.createDocumentFragment();
      fragment.textContent = text;
      return fragment;
    }

    const fragment = document.createDocumentFragment();
    const searchTerms = searchQuery.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const regex = new RegExp(`(${searchTerms.map(term => this.escapeRegExp(term)).join('|')})`, "gi");
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      // Add non-highlighted text before match
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      // Add highlighted match
      const span = document.createElement("span");
      span.className = "systemsculpt-search-highlight";
      span.textContent = match[0];
      fragment.appendChild(span);

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    return fragment;
  }

  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
  }
}
