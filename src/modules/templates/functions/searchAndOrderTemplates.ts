import { TFile, App } from 'obsidian';
import { parseFrontMatter } from './parseFrontMatter';

export async function searchAndOrderTemplates(
  app: App,
  templateFiles: TFile[],
  query: string
): Promise<TFile[]> {
  if (!query) {
    return templateFiles;
  }

  const lowerCaseQuery = query.toLowerCase();
  const scoredTemplates = await Promise.all(
    templateFiles.map(async file => {
      const fileContent = await app.vault.cachedRead(file);
      const { name, description } = parseFrontMatter(fileContent);
      const nameScore = name.toLowerCase().includes(lowerCaseQuery) ? 1 : 0;
      const descriptionScore = description
        .toLowerCase()
        .includes(lowerCaseQuery)
        ? 1
        : 0;
      return {
        file,
        score: nameScore + descriptionScore,
      };
    })
  );

  return scoredTemplates
    .sort((a, b) => b.score - a.score)
    .map(({ file }) => file);
}
