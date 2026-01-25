import { MemoryProfiler } from './MemoryProfiler';

export interface FunctionTrace {
    name: string;
    module: string;
    startTime: number;
    endTime?: number;
    duration?: number;
    memoryBefore: number;
    memoryAfter?: number;
    memoryDelta?: number;
    callStack: string[];
    args?: any[];
    result?: any;
    error?: Error;
    childCalls: FunctionTrace[];
}

export interface ProfileReport {
    startTime: number;
    endTime: number;
    totalDuration: number;
    traces: FunctionTrace[];
    memoryPeaks: Array<{
        timestamp: number;
        memory: number;
        function: string;
    }>;
    slowestFunctions: Array<{
        name: string;
        duration: number;
        memoryDelta: number;
    }>;
    memoryHogs: Array<{
        name: string;
        memoryDelta: number;
        duration: number;
    }>;
}

/**
 * Function-level performance profiler for tracking memory and execution time
 */
export class FunctionProfiler {
    private traces: Map<string, FunctionTrace> = new Map();
    private callStack: string[] = [];
    private memoryPeaks: Array<{ timestamp: number; memory: number; function: string }> = [];
    private enabled: boolean = false;
    private profileStartTime: number = 0;
    private maxTraces: number = 10000; // Limit to prevent memory issues
    private samplingRate: number = 1; // Sample every call by default
    private sampleCounter: number = 0;
    private traceListeners: Array<(trace: FunctionTrace) => void> = [];
    
    constructor() {
        // Enable by default for debugging
        this.enabled = true;
    }
    
    /**
     * Enable or disable profiling
     */
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (enabled) {
            this.reset();
            this.profileStartTime = performance.now();
        }
    }
    
    /**
     * Set sampling rate (0-1, where 1 means profile every call)
     */
    setSamplingRate(rate: number): void {
        this.samplingRate = Math.max(0, Math.min(1, rate));
    }
    
    /**
     * Start tracing a function call
     */
    startTrace(functionName: string, moduleName: string, args?: any[]): string | null {
        if (!this.enabled) return null;
        
        // Apply sampling
        this.sampleCounter++;
        if (this.sampleCounter % Math.floor(1 / this.samplingRate) !== 0) {
            return null;
        }
        
        // Prevent trace explosion
        if (this.traces.size >= this.maxTraces) {
            return null;
        }
        
        const traceId = `${moduleName}.${functionName}_${Date.now()}_${Math.random()}`;
        const memoryInfo = typeof window !== "undefined" ? (window.performance as any)?.memory : undefined;
        const heapUsed = typeof memoryInfo?.usedJSHeapSize === "number" ? memoryInfo.usedJSHeapSize : 0;
        
        const trace: FunctionTrace = {
            name: functionName,
            module: moduleName,
            startTime: performance.now(),
            memoryBefore: heapUsed,
            callStack: [...this.callStack],
            args: args,
            childCalls: []
        };
        
        this.traces.set(traceId, trace);
        this.callStack.push(`${moduleName}.${functionName}`);
        
        // Check for memory peak
        if (heapUsed > (this.memoryPeaks[this.memoryPeaks.length - 1]?.memory || 0)) {
            this.memoryPeaks.push({
                timestamp: performance.now(),
                memory: heapUsed,
                function: `${moduleName}.${functionName}`
            });
            
            // Keep only top 100 peaks
            if (this.memoryPeaks.length > 100) {
                this.memoryPeaks.sort((a, b) => b.memory - a.memory);
                this.memoryPeaks = this.memoryPeaks.slice(0, 100);
            }
        }
        
        return traceId;
    }
    
    /**
     * End tracing a function call
     */
    endTrace(traceId: string | null, result?: any, error?: Error): void {
        if (!this.enabled || !traceId) return;
        
        const trace = this.traces.get(traceId);
        if (!trace) return;
        
        const memoryInfo = typeof window !== "undefined" ? (window.performance as any)?.memory : undefined;
        const heapUsed = typeof memoryInfo?.usedJSHeapSize === "number" ? memoryInfo.usedJSHeapSize : 0;
        trace.endTime = performance.now();
        trace.duration = trace.endTime - trace.startTime;
        trace.memoryAfter = heapUsed;
        trace.memoryDelta = (trace.memoryAfter || 0) - trace.memoryBefore;
        trace.result = result;
        trace.error = error;
        
        // Update call stack
        this.callStack.pop();
        
        // Add to parent's child calls if exists
        if (this.callStack.length > 0) {
            const parentName = this.callStack[this.callStack.length - 1];
            for (const [id, t] of this.traces) {
                if (`${t.module}.${t.name}` === parentName && !t.endTime) {
                    t.childCalls.push(trace);
                    break;
                }
            }
        }
        
        this.notifyTraceListeners(trace);
    }
    
    /**
     * Create a decorator for automatic function profiling
     */
    profileFunction<T extends (...args: any[]) => any>(
        fn: T,
        functionName: string,
        moduleName: string
    ): T {
        const profiler = this;
        
        return function(this: any, ...args: any[]): any {
            const traceId = profiler.startTrace(functionName, moduleName, args);
            
            try {
                const result = fn.apply(this, args);
                
                // Handle async functions
                if (result instanceof Promise) {
                    return result
                        .then((res) => {
                            profiler.endTrace(traceId, res);
                            return res;
                        })
                        .catch((err) => {
                            profiler.endTrace(traceId, undefined, err);
                            throw err;
                        });
                }
                
                profiler.endTrace(traceId, result);
                return result;
            } catch (error) {
                profiler.endTrace(traceId, undefined, error as Error);
                throw error;
            }
        } as T;
    }
    
    /**
     * Get current profiling report
     */
    getReport(): ProfileReport {
        const now = performance.now();
        const allTraces = Array.from(this.traces.values());
        const completedTraces = allTraces.filter(t => t.endTime);
        
        // Calculate slowest functions
        const slowestFunctions = completedTraces
            .sort((a, b) => (b.duration || 0) - (a.duration || 0))
            .slice(0, 20)
            .map(t => ({
                name: `${t.module}.${t.name}`,
                duration: t.duration || 0,
                memoryDelta: t.memoryDelta || 0
            }));
        
        // Calculate memory hogs
        const memoryHogs = completedTraces
            .filter(t => t.memoryDelta && t.memoryDelta > 0)
            .sort((a, b) => (b.memoryDelta || 0) - (a.memoryDelta || 0))
            .slice(0, 20)
            .map(t => ({
                name: `${t.module}.${t.name}`,
                memoryDelta: t.memoryDelta || 0,
                duration: t.duration || 0
            }));
        
        return {
            startTime: this.profileStartTime,
            endTime: now,
            totalDuration: now - this.profileStartTime,
            traces: completedTraces,
            memoryPeaks: this.memoryPeaks,
            slowestFunctions,
            memoryHogs
        };
    }
    
    /**
     * Generate a detailed report string
     */
    async generateReportString(components?: Record<string, any>): Promise<string> {
        const report = this.getReport();
        
        // Get real memory analysis
        const memoryProfiler = MemoryProfiler.getInstance();
        const memorySnapshot = await memoryProfiler.takeSnapshot(components);
        
        const lines: string[] = [
            '=== REAL MEMORY ANALYSIS ===',
            memorySnapshot.summary,
            '',
            '=== Function Call Statistics ===',
            `Duration: ${(report.totalDuration / 1000).toFixed(2)}s`,
            `Total Traces: ${report.traces.length}`,
            '',
            '=== Call Frequency (Top 10) ===',
            ...this.getCallFrequency().slice(0, 10).map(([name, count], i) => 
                `${i + 1}. ${name}: ${count} calls`
            ),
            '',
            '=== Slowest Functions (Top 10) ===',
            ...report.slowestFunctions.slice(0, 10).map((fn, i) => 
                `${i + 1}. ${fn.name}: ${fn.duration.toFixed(2)}ms`
            )
        ];
        
        return lines.join('\n');
    }
    
    /**
     * Get call frequency statistics
     */
    private getCallFrequency(): Array<[string, number]> {
        const frequency = new Map<string, number>();
        
        for (const trace of this.traces.values()) {
            const key = `${trace.module}.${trace.name}`;
            frequency.set(key, (frequency.get(key) || 0) + 1);
        }
        
        return Array.from(frequency.entries())
            .sort((a, b) => b[1] - a[1]);
    }
    
    /**
     * Export detailed trace data as JSON
     */
    exportTracesAsJson(): string {
        const report = this.getReport();
        return JSON.stringify(report, (key, value) => {
            // Handle circular references and limit data size
            if (key === 'args' || key === 'result') {
                try {
                    return JSON.stringify(value).substring(0, 100) + '...';
                } catch {
                    return '[Circular or Complex Object]';
                }
            }
            if (key === 'error' && value instanceof Error) {
                return {
                    message: value.message,
                    stack: value.stack,
                    name: value.name
                };
            }
            return value;
        }, 2);
    }
    
    /**
     * Reset all profiling data
     */
    reset(): void {
        this.traces.clear();
        this.callStack = [];
        this.memoryPeaks = [];
        this.profileStartTime = performance.now();
        this.sampleCounter = 0;
    }
    
    /**
     * Create a flame graph compatible data structure
     */
    getFlameGraphData(): any {
        const rootTraces = Array.from(this.traces.values())
            .filter(t => t.callStack.length === 0 && t.endTime);
        
        const buildNode = (trace: FunctionTrace): any => ({
            name: `${trace.module}.${trace.name}`,
            value: trace.duration || 0,
            children: trace.childCalls.map(buildNode)
        });
        
        return {
            name: 'root',
            value: 0,
            children: rootTraces.map(buildNode)
        };
    }

    addTraceCompleteListener(listener: (trace: FunctionTrace) => void): () => void {
        this.traceListeners.push(listener);
        return () => {
            this.traceListeners = this.traceListeners.filter((fn) => fn !== listener);
        };
    }

    private notifyTraceListeners(trace: FunctionTrace): void {
        for (const listener of this.traceListeners) {
            try {
                listener(trace);
            } catch (error) {
                console.warn("[SystemSculpt][FunctionProfiler] listener error", error);
            }
        }
    }
}

// Singleton instance
let profilerInstance: FunctionProfiler | null = null;

export function getFunctionProfiler(): FunctionProfiler {
    if (!profilerInstance) {
        profilerInstance = new FunctionProfiler();
    }
    return profilerInstance;
}

/**
 * Decorator for profiling class methods
 */
export function profile(moduleName: string) {
    return function(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const originalMethod = descriptor.value;
        const profiler = getFunctionProfiler();
        
        descriptor.value = profiler.profileFunction(
            originalMethod,
            propertyKey,
            moduleName || target.constructor.name
        );
        
        return descriptor;
    };
}
