import { App, TFile } from 'obsidian';
import { parseFrontMatter } from './parseFrontMatter';

export async function renderTemplateList(
  app: App,
  value: string,
  templateFile: TFile,
  el: HTMLElement
): Promise<void> {
  const frontMatter = await parseFrontMatter(app, templateFile);
  const { name, description, model, maxTokens, tags } = frontMatter;

  el.empty();

  const nameEl = el.createEl('h2');
  nameEl.textContent = name;
  nameEl.addClass('template-name');

  const descriptionEl = el.createEl('p');
  const truncatedDescription =
    description.length > 125
      ? `${description.substring(0, 125)}...`
      : description;
  descriptionEl.textContent = truncatedDescription;
  descriptionEl.addClass('template-description');

  const metaEl = el.createEl('div', { cls: 'template-meta' });

  const modelEl = metaEl.createEl('span', { cls: 'template-meta-item' });
  modelEl.textContent = model;

  const maxTokensEl = metaEl.createEl('span', { cls: 'template-meta-item' });
  maxTokensEl.textContent = `${maxTokens} max`;

  const tagsContainer = metaEl.createEl('div', { cls: 'template-tags' });
  tags.forEach((tag, index) => {
    const tagEl = tagsContainer.createEl('span', { cls: 'template-tag' });
    tagEl.textContent = tag.trim();
  });
}
