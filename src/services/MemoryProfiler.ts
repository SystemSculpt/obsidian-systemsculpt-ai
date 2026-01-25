/**
 * Enhanced Memory Profiler - Shows where memory is ACTUALLY being used
 * Not just function allocations, but actual memory held by components
 */
import { DEFAULT_EMBEDDING_DIMENSION } from "../constants/embeddings";

export interface MemorySnapshot {
  timestamp: number;
  heapUsed: number;
  components: ComponentMemory[];
  largestObjects: ObjectMemory[];
  summary: string;
}

export interface ComponentMemory {
  name: string;
  size: number;
  details: Record<string, number>;
}

export interface ObjectMemory {
  type: string;
  size: number;
  count: number;
  location?: string;
}

export class MemoryProfiler {
  private static instance: MemoryProfiler | null = null;
  private snapshots: MemorySnapshot[] = [];
  
  static getInstance(): MemoryProfiler {
    if (!this.instance) {
      this.instance = new MemoryProfiler();
    }
    return this.instance;
  }
  
  /**
   * Clear the singleton instance to allow proper cleanup
   */
  static clearInstance(): void {
    if (this.instance) {
      this.instance.snapshots = [];
      this.instance = null;
    }
  }
  
  /**
   * Take a memory snapshot showing actual memory usage
   */
  async takeSnapshot(components?: Record<string, any>): Promise<MemorySnapshot> {
    const heapUsed = (window.performance as any).memory?.usedJSHeapSize || 0;
    const componentMemory: ComponentMemory[] = [];
    const largestObjects: ObjectMemory[] = [];
    
    // Analyze provided components
    if (components) {
      for (const [name, component] of Object.entries(components)) {
        const memory = this.analyzeComponent(name, component);
        if (memory.size > 0) {
          componentMemory.push(memory);
        }
      }
    }
    
    // DEEP GLOBAL ANALYSIS - Find what's REALLY using memory
    const globalAnalysis = this.analyzeGlobalScope();
    componentMemory.push(...globalAnalysis);
    
    // Sort by size
    componentMemory.sort((a, b) => b.size - a.size);
    
    // Create summary
    const totalTracked = componentMemory.reduce((sum, c) => sum + c.size, 0);
    const unaccounted = heapUsed - totalTracked;
    
    const snapshot: MemorySnapshot = {
      timestamp: Date.now(),
      heapUsed,
      components: componentMemory,
      largestObjects,
      summary: this.createSummary(heapUsed, componentMemory, unaccounted)
    };
    
    this.snapshots.push(snapshot);
    return snapshot;
  }
  
  /**
   * Analyze a component's memory usage with DEEP inspection
   */
  private analyzeComponent(name: string, component: any): ComponentMemory {
    const details: Record<string, number> = {};
    let totalSize = 0;
    
    // Special handling for known memory-heavy components
    if (name === 'OramaSearchEngine' && component) {
      // Check caches
      if (component.documentCache instanceof Map) {
        const docCacheSize = this.estimateMapSize(component.documentCache);
        details['documentCache'] = docCacheSize;
        totalSize += docCacheSize;
      }
      
      if (component.embeddingCache instanceof Map) {
        const embCacheSize = this.estimateEmbeddingCacheSize(component.embeddingCache);
        details['embeddingCache'] = embCacheSize;
        totalSize += embCacheSize;
      }
      
      // DEEP analysis of Orama DB - this is where the memory is hiding!
      if (component.db) {
        const dbAnalysis = this.deepAnalyzeOramaDB(component.db);
        Object.assign(details, dbAnalysis);
        const dbTotal = Object.values(dbAnalysis).reduce((sum, size) => sum + size, 0);
        totalSize += dbTotal;
      }
    }
    
    // EmbeddingsManager
    else if (name === 'EmbeddingsManager' && component) {
      // Analyze embeddings data
      if (component.data) {
        const dataSize = this.deepAnalyzeObject(component.data);
        details['data'] = dataSize;
        totalSize += dataSize;
      }
      
      // Analyze cache
      if (component.indexOps) {
        const indexOpsSize = this.deepAnalyzeObject(component.indexOps);
        details['indexOps'] = indexOpsSize;
        totalSize += indexOpsSize;
      }
      
      // Analyze retriever
      if (component.retriever) {
        const retrieverSize = this.deepAnalyzeObject(component.retriever);
        details['retriever'] = retrieverSize;
        totalSize += retrieverSize;
      }
      
      // Check for any loaded partitions
      if (component.dbOps && component.dbOps.loadedPartitions) {
        const partitionsSize = this.deepAnalyzeObject(component.dbOps.loadedPartitions);
        details['loadedPartitions'] = partitionsSize;
        totalSize += partitionsSize;
      }
    }
    
    // StorageAdapter
    else if (name === 'StorageAdapter' && component) {
      if (component.memoryCache instanceof Map) {
        const cacheSize = this.deepAnalyzeMap(component.memoryCache);
        details['memoryCache'] = cacheSize;
        totalSize += cacheSize;
      }
      
      // Check for any other hidden properties
      const allProps = this.getAllProperties(component);
      for (const prop of allProps) {
        if (!details[prop] && component[prop]) {
          const propSize = this.deepAnalyzeObject(component[prop]);
          if (propSize > 1024) { // Only include if > 1KB
            details[prop] = propSize;
            totalSize += propSize;
          }
        }
      }
    }
    
    // Generic deep analysis for other objects
    else {
      totalSize = this.deepAnalyzeObject(component);
    }
    
    return { name, size: totalSize, details };
  }
  
  /**
   * Estimate Map size in bytes
   */
  private estimateMapSize(map: Map<any, any>): number {
    let size = 0;
    for (const [key, value] of map) {
      size += this.estimateStringSize(key);
      size += this.estimateObjectSize(value);
    }
    return size;
  }
  
  /**
   * Estimate embedding cache size (arrays of numbers)
   */
  private estimateEmbeddingCacheSize(cache: Map<string, number[]>): number {
    let size = 0;
    for (const [key, embedding] of cache) {
      size += this.estimateStringSize(key);
      size += embedding.length * 8; // 8 bytes per float64
    }
    return size;
  }
  
  /**
   * Estimate LRU cache size
   */
  private estimateLRUCacheSize(cache: any): number {
    if (!cache || typeof cache.size !== 'function') return 0;
    
    let size = 0;
    const cacheSize = cache.size();
    
    // Estimate based on typical embedding data size
    // Each cached item is likely an EmbeddingData object with a large float array
    const avgEmbeddingSize = DEFAULT_EMBEDDING_DIMENSION * 8;
    const avgMetadataSize = 500; // Metadata overhead
    
    size = cacheSize * (avgEmbeddingSize + avgMetadataSize);
    return size;
  }
  
  /**
   * Estimate object size (rough approximation)
   */
  private estimateObjectSize(obj: any, maxDepth: number = 3, currentDepth: number = 0): number {
    if (!obj || currentDepth > maxDepth) return 0;
    
    let size = 0;
    const seen = new WeakSet();
    
    const traverse = (current: any, depth: number): void => {
      if (!current || seen.has(current) || depth > maxDepth) return;
      if (typeof current === 'object') seen.add(current);
      
      if (typeof current === 'string') {
        size += this.estimateStringSize(current);
      } else if (typeof current === 'number') {
        size += 8;
      } else if (typeof current === 'boolean') {
        size += 4;
      } else if (Array.isArray(current)) {
        size += 4 + (current.length * 8); // Rough estimate
        // Don't traverse deep arrays
      } else if (current instanceof Map) {
        size += current.size * 1000; // Rough estimate
      } else if (current instanceof Set) {
        size += current.size * 100; // Rough estimate
      } else if (typeof current === 'object') {
        size += 100; // Object overhead estimate
        // Don't traverse deep objects
      }
    };
    
    traverse(obj, currentDepth);
    return size;
  }

  /**
   * DEEP analysis of Orama database structure
   */
  private deepAnalyzeOramaDB(db: any): Record<string, number> {
    const analysis: Record<string, number> = {};
    
    if (!db) return analysis;
    
    // Analyze data property which holds the actual documents
    if (db.data) {
      let dataSize = 0;
      const docs = db.data.docs || db.data.documents || db.data;
      
      if (docs instanceof Map) {
        dataSize = this.deepAnalyzeMap(docs);
      } else if (Array.isArray(docs)) {
        dataSize = this.deepAnalyzeArray(docs);
      } else if (typeof docs === 'object') {
        dataSize = this.deepAnalyzeObject(docs);
      }
      
      analysis['orama.data'] = dataSize;
    }
    
    // Analyze index property
    if (db.index) {
      analysis['orama.index'] = this.deepAnalyzeObject(db.index);
    }
    
    // Analyze docs property
    if (db.docs) {
      analysis['orama.docs'] = this.deepAnalyzeObject(db.docs);
    }
    
    // Check for vectorIndex (where embeddings might be stored)
    if (db.vectorIndex) {
      analysis['orama.vectorIndex'] = this.deepAnalyzeObject(db.vectorIndex);
    }
    
    // Check all other properties
    const props = this.getAllProperties(db);
    for (const prop of props) {
      if (!['data', 'index', 'docs', 'vectorIndex'].includes(prop)) {
        const propSize = this.deepAnalyzeObject(db[prop]);
        if (propSize > 10240) { // Only include if > 10KB
          analysis[`orama.${prop}`] = propSize;
        }
      }
    }
    
    return analysis;
  }

  /**
   * Deep analyze any object, following all references
   */
  private deepAnalyzeObject(obj: any, seen = new WeakSet(), depth = 0): number {
    if (!obj || seen.has(obj) || depth > 8) return 0; // Reduced depth to prevent freezes
    if (typeof obj === 'object') seen.add(obj);
    
    // CRITICAL: Skip problematic objects that cause freezes
    if (this.isProblematicObject(obj)) {
      return 1000; // Rough estimate instead of traversing
    }
    
    let size = 0;
    
    if (typeof obj === 'string') {
      size = this.estimateStringSize(obj);
    } else if (typeof obj === 'number') {
      size = 8;
    } else if (typeof obj === 'boolean') {
      size = 4;
    } else if (obj instanceof Float32Array || obj instanceof Float64Array) {
      size = obj.byteLength;
    } else if (obj instanceof ArrayBuffer) {
      size = obj.byteLength;
    } else if (Array.isArray(obj)) {
      size = this.deepAnalyzeArray(obj, seen, depth + 1);
    } else if (obj instanceof Map) {
      size = this.deepAnalyzeMap(obj, seen, depth + 1);
    } else if (obj instanceof Set) {
      size = this.deepAnalyzeSet(obj, seen, depth + 1);
    } else if (typeof obj === 'object') {
      size = 100; // Object overhead
      
      // Analyze all properties but skip problematic ones
      const props = this.getAllProperties(obj);
      for (const prop of props) {
        // Skip known problematic properties
        if (this.isProblematicProperty(prop)) continue;
        
        try {
          size += this.deepAnalyzeObject(obj[prop], seen, depth + 1);
        } catch (e) {
          // Skip inaccessible properties
        }
      }
    }
    
    return size;
  }

  /**
   * Deep analyze Map
   */
  private deepAnalyzeMap(map: Map<any, any>, seen = new WeakSet(), depth = 0): number {
    let size = 50; // Map overhead
    
    for (const [key, value] of map) {
      size += this.deepAnalyzeObject(key, seen, depth);
      size += this.deepAnalyzeObject(value, seen, depth);
    }
    
    return size;
  }

  /**
   * Deep analyze Set
   */
  private deepAnalyzeSet(set: Set<any>, seen = new WeakSet(), depth = 0): number {
    let size = 50; // Set overhead
    
    for (const value of set) {
      size += this.deepAnalyzeObject(value, seen, depth);
    }
    
    return size;
  }

  /**
   * Deep analyze Array with special handling for typed arrays
   */
  private deepAnalyzeArray(arr: any[], seen = new WeakSet(), depth = 0): number {
    let size = 24; // Array overhead
    
    // For numeric arrays (likely embeddings), calculate exact size
    if (arr.length > 0 && typeof arr[0] === 'number') {
      size += arr.length * 8; // 8 bytes per number
    } else {
      // For other arrays, analyze each element
      for (const item of arr) {
        size += this.deepAnalyzeObject(item, seen, depth);
      }
    }
    
    return size;
  }

  /**
   * Get all properties including non-enumerable ones
   */
  private getAllProperties(obj: any): string[] {
    const props = new Set<string>();
    
    // Get enumerable properties
    for (const prop in obj) {
      props.add(prop);
    }
    
    // Get all properties including non-enumerable
    try {
      const allProps = Object.getOwnPropertyNames(obj);
      for (const prop of allProps) {
        props.add(prop);
      }
    } catch (e) {
      // Some objects don't support getOwnPropertyNames
    }
    
    return Array.from(props);
  }
  
  /**
   * Estimate string size in bytes
   */
  private estimateStringSize(str: string): number {
    return str.length * 2; // UTF-16 encoding
  }
  
  /**
   * Create a human-readable summary
   */
  private createSummary(heapUsed: number, components: ComponentMemory[], unaccounted: number): string {
    const formatSize = (bytes: number): string => {
      if (bytes < 1024) return `${bytes}B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
      return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
    };
    
    let summary = `MEMORY BREAKDOWN - Total Heap: ${formatSize(heapUsed)}\n\n`;
    summary += `TOP MEMORY CONSUMERS:\n`;
    
    for (const component of components.slice(0, 5)) {
      const percentage = ((component.size / heapUsed) * 100).toFixed(1);
      summary += `\n${component.name}: ${formatSize(component.size)} (${percentage}%)\n`;
      
      // Show details
      for (const [detail, size] of Object.entries(component.details)) {
        summary += `  - ${detail}: ${formatSize(size)}\n`;
      }
    }
    
    if (unaccounted > 0) {
      const percentage = ((unaccounted / heapUsed) * 100).toFixed(1);
      summary += `\nUnaccounted: ${formatSize(unaccounted)} (${percentage}%)\n`;
    }
    
    return summary;
  }
  
  /**
   * Get memory report
   */
  getReport(): string {
    if (this.snapshots.length === 0) return 'No memory snapshots taken';
    
    const latest = this.snapshots[this.snapshots.length - 1];
    return latest.summary;
  }
  
  /**
   * Clear snapshots
   */
  clear(): void {
    this.snapshots = [];
  }

  /**
   * Check if object is problematic (causes freezes when traversed)
   */
  private isProblematicObject(obj: any): boolean {
    if (!obj) return false;
    
    // Skip PixiJS objects (from canvas-minimap plugin)
    const className = obj.constructor?.name || '';
    if (className.includes('PIXI') || className.includes('Pixi')) {
      return true;
    }
    
    // Skip WebGL/Canvas objects
    if (obj instanceof WebGLRenderingContext || 
        obj instanceof WebGL2RenderingContext ||
        obj instanceof CanvasRenderingContext2D ||
        obj instanceof HTMLCanvasElement) {
      return true;
    }
    
    // Skip DOM nodes (they have circular references)
    if (obj instanceof Node || obj instanceof Element) {
      return true;
    }
    
    // Skip electron/node objects
    if (className.includes('Electron') || className.includes('BrowserWindow')) {
      return true;
    }
    
    return false;
  }

  /**
   * Check if property name is problematic
   */
  private isProblematicProperty(prop: string): boolean {
    const problematicProps = [
      // PixiJS properties that trigger deprecation warnings
      'filters', 'AlphaFilter', 'BlurFilter', 'ColorMatrixFilter',
      'DisplacementFilter', 'FXAAFilter', 'NoiseFilter',
      'FILTER_RESOLUTION', 'FILTER_MULTISAMPLE',
      
      // Circular reference properties
      'parent', 'parentNode', 'ownerDocument', 'view',
      
      // Large/infinite properties
      'window', 'global', 'process', 'require',
      
      // WebGL properties
      'gl', 'webgl', 'context', 'canvas'
    ];
    
    return problematicProps.includes(prop);
  }

  /**
   * Analyze global scope to find hidden memory usage
   */
  private analyzeGlobalScope(): ComponentMemory[] {
    const components: ComponentMemory[] = [];
    
    // Analyze Obsidian app object
    if ((window as any).app) {
      const app = (window as any).app;
      
      // Analyze all plugins
      if (app.plugins && app.plugins.plugins) {
        for (const [pluginId, plugin] of Object.entries(app.plugins.plugins)) {
          const pluginMemory = this.analyzePlugin(pluginId, plugin);
          if (pluginMemory.size > 1024 * 1024) { // Only include if > 1MB
            components.push(pluginMemory);
          }
        }
      }
      
      // Analyze workspace
      if (app.workspace) {
        const workspaceSize = this.deepAnalyzeObject(app.workspace);
        if (workspaceSize > 1024 * 1024) {
          components.push({
            name: 'Obsidian.workspace',
            size: workspaceSize,
            details: {}
          });
        }
      }
      
      // Analyze metadataCache
      if (app.metadataCache) {
        const cacheSize = this.deepAnalyzeObject(app.metadataCache);
        if (cacheSize > 1024 * 1024) {
          components.push({
            name: 'Obsidian.metadataCache',
            size: cacheSize,
            details: {}
          });
        }
      }
      
      // Analyze vault
      if (app.vault) {
        const vaultSize = this.analyzeVault(app.vault);
        if (vaultSize > 1024 * 1024) {
          components.push({
            name: 'Obsidian.vault',
            size: vaultSize,
            details: {}
          });
        }
      }
    }
    
    // Analyze window properties for large objects
    const windowProps = this.analyzeWindowProperties();
    components.push(...windowProps);
    
    return components;
  }

  /**
   * Analyze a plugin's memory usage
   */
  private analyzePlugin(pluginId: string, plugin: any): ComponentMemory {
    const details: Record<string, number> = {};
    let totalSize = 0;
    
    // Check for embeddings-related data
    if (plugin.embeddingsManager) {
      const embSize = this.deepAnalyzeObject(plugin.embeddingsManager);
      details['embeddingsManager'] = embSize;
      totalSize += embSize;
    }
    
    if (plugin.searchEngine) {
      const searchSize = this.deepAnalyzeObject(plugin.searchEngine);
      details['searchEngine'] = searchSize;
      totalSize += searchSize;
    }
    
    // Check all properties
    const props = this.getAllProperties(plugin);
    const alreadyAnalyzed = new Set(['embeddingsManager', 'searchEngine']);
    
    for (const prop of props) {
      if (!['manifest', 'app'].includes(prop) && !alreadyAnalyzed.has(prop) && plugin[prop]) {
        try {
          const propSize = this.deepAnalyzeObject(plugin[prop]);
          if (propSize > 100 * 1024) { // > 100KB
            details[prop] = propSize;
            totalSize += propSize;
          }
        } catch (e) {
          // Skip errors
        }
      }
    }
    
    return {
      name: `Plugin.${pluginId}`,
      size: totalSize,
      details
    };
  }

  /**
   * Analyze vault for cached content
   */
  private analyzeVault(vault: any): number {
    let size = 0;
    
    // Check for cached file contents
    if (vault.fileCache) {
      size += this.deepAnalyzeObject(vault.fileCache);
    }
    
    // Check for other caches
    const props = this.getAllProperties(vault);
    for (const prop of props) {
      if (prop.includes('cache') || prop.includes('Cache')) {
        try {
          size += this.deepAnalyzeObject(vault[prop]);
        } catch (e) {
          // Skip errors
        }
      }
    }
    
    return size;
  }

  /**
   * Analyze window properties for large objects
   */
  private analyzeWindowProperties(): ComponentMemory[] {
    const components: ComponentMemory[] = [];
    const ignoredProps = new Set(['app', 'document', 'window', 'self', 'top', 'parent', 'frames']);
    
    try {
      const windowProps = Object.getOwnPropertyNames(window);
      
      for (const prop of windowProps) {
        if (ignoredProps.has(prop)) continue;
        
        try {
          const value = (window as any)[prop];
          if (value && typeof value === 'object') {
            const size = this.deepAnalyzeObject(value);
            
            if (size > 10 * 1024 * 1024) { // > 10MB
              components.push({
                name: `window.${prop}`,
                size,
                details: {}
              });
            }
          }
        } catch (e) {
          // Skip inaccessible properties
        }
      }
    } catch (e) {
      // Skip if we can't enumerate window
    }
    
    return components;
  }
}
