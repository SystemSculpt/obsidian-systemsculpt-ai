import { App, TFile, TFolder } from 'obsidian';
import { validateFrontMatter } from './validateFrontMatter';

export function getTemplateFiles(app: App, templatesPath: string): TFile[] {
  const { vault } = app;
  const templateFolder = vault.getAbstractFileByPath(templatesPath);

  if (templateFolder instanceof TFolder) {
    return templateFolder.children.filter(
      file => file instanceof TFile && validateFrontMatter(app, file)
    ) as TFile[];
  }

  return [];
}
