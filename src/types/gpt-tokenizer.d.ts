/**
 * Custom type declarations for gpt-tokenizer package
 * The original package has invalid TypeScript syntax in its .d.ts files
 */

declare module 'gpt-tokenizer' {
  export function encode(text: string): number[];
  export function decode(tokens: number[]): string;
  
  export interface ModelInfo {
    name: string;
    maxTokens: number;
    vocabulary: number;
  }
  
  export const models: Record<string, ModelInfo>;
}

declare module 'gpt-tokenizer/esm/encoding' {
  export function encode(text: string): number[];
  export function decode(tokens: number[]): string;
}

declare module 'gpt-tokenizer/esm/models' {
  export interface ModelSpec {
    name: string;
    maxTokens: number;
    vocabulary: number;
  }
  
  export const models: Record<string, ModelSpec>;
}