import { App, TFile } from 'obsidian';

export interface FrontMatter {
  name: string;
  description: string;
  model: string;
  maxTokens: number;
  prompt: string;
}

export async function parseFrontMatter(
  app: App,
  file: TFile
): Promise<FrontMatter> {
  const fileCache = app.metadataCache.getFileCache(file);
  const frontMatter = fileCache?.frontmatter;

  if (frontMatter) {
    return {
      name: frontMatter.name || '',
      description: frontMatter.description || '',
      model: frontMatter.model || '',
      maxTokens: frontMatter['max tokens'] || 0,
      prompt: await app.vault.read(file),
    };
  }

  return {
    name: '',
    description: '',
    model: '',
    maxTokens: 0,
    prompt: '',
  };
}
