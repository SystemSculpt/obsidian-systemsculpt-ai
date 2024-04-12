import { App, TFile, TFolder } from 'obsidian';
import { parseFrontMatter } from './parseFrontMatter';

export async function getTemplateFiles(
  app: App,
  templatesPath: string
): Promise<TFile[]> {
  const { vault } = app;
  const templateFolder = vault.getAbstractFileByPath(templatesPath);

  async function recursivelyCollectTemplates(
    folder: TFolder
  ): Promise<TFile[]> {
    let templates: TFile[] = [];
    for (const child of folder.children) {
      if (child instanceof TFolder) {
        templates = templates.concat(await recursivelyCollectTemplates(child));
      } else if (child instanceof TFile) {
        const frontMatter = await parseFrontMatter(app, child);
        if (
          frontMatter.name &&
          frontMatter.description &&
          frontMatter.model &&
          frontMatter.maxTokens
        ) {
          templates.push(child);
        }
      }
    }
    return templates;
  }

  if (templateFolder instanceof TFolder) {
    return await recursivelyCollectTemplates(templateFolder);
  }

  return [];
}
