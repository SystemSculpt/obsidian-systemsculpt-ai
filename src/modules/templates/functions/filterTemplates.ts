import { TFile } from 'obsidian';

export function filterTemplates(
  templateFiles: TFile[],
  query: string
): TFile[] {
  if (!query) {
    return templateFiles;
  }

  const lowerCaseQuery = query.toLowerCase();
  return templateFiles.filter(file =>
    file.basename.toLowerCase().includes(lowerCaseQuery)
  );
}
