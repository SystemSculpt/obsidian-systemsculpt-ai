export function buildPrompt(
  prompt: string,
  maxTokens: number,
  context: string
): string {
  const tokenLimitationPrompt = `# Token Limitation\nYou can generate up to ${maxTokens} tokens for this response. Generate wisely.`;
  const promptWithContext = prompt.replace('{{context}}', context);

  return `${tokenLimitationPrompt}\n\n${promptWithContext}`;
}
