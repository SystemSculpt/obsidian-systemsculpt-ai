export interface FrontMatter {
  name: string;
  description: string;
  model: string;
  maxTokens: number;
  prompt: string;
}

export function parseFrontMatter(content: string): FrontMatter {
  const frontMatterRegex = /---\n([\s\S]*?)\n---/;
  const frontMatterMatch = content.match(frontMatterRegex);

  if (frontMatterMatch) {
    const frontMatterContent = frontMatterMatch[1];
    const frontMatter = {} as FrontMatter;

    frontMatterContent.split('\n').forEach(line => {
      const [key, value] = line.split(':').map(item => item.trim());
      if (key === 'max tokens') {
        frontMatter.maxTokens = parseInt(value, 10);
      } else {
        (frontMatter as any)[key] = value;
      }
    });

    const promptContent = content.slice(frontMatterMatch[0].length).trim();
    frontMatter.prompt = promptContent;

    return frontMatter;
  }

  return {
    name: '',
    description: '',
    model: '',
    maxTokens: 0,
    prompt: '',
  };
}
