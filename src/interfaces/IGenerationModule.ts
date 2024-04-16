export interface IGenerationModule {
  abortController: AbortController | null;
  isGenerationCompleted: boolean;
  stopGeneration(): void;
}
