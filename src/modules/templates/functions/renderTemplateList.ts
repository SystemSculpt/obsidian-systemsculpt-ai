import { App, TFile } from 'obsidian';
import { parseFrontMatter } from './parseFrontMatter';

export async function renderTemplateList(
  app: App,
  value: string,
  templateFile: TFile,
  el: HTMLElement
): Promise<void> {
  const frontMatter = await parseFrontMatter(app, templateFile);
  const { name, description, maxTokens } = frontMatter;

  el.empty();

  const nameEl = el.createEl('h2');
  nameEl.textContent = name;
  nameEl.style.fontSize = '16px';

  const descriptionEl = el.createEl('p');
  const truncatedDescription =
    description.length > 100
      ? `${description.substring(0, 100)}...`
      : description;
  descriptionEl.textContent = truncatedDescription;
  descriptionEl.style.fontSize = '12px';
}
