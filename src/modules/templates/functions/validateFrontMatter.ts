import { App, TFile } from 'obsidian';

export function validateFrontMatter(app: App, file: TFile): boolean {
  const fileCache = app.metadataCache.getFileCache(file);
  const frontMatter = fileCache?.frontmatter;

  return (
    frontMatter &&
    frontMatter.name &&
    frontMatter.description &&
    frontMatter.model &&
    frontMatter['max tokens']
  );
}
