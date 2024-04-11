export interface BrainSettings {
  openAIApiKey: string;
  defaultOpenAIModelId: string;
  generateTitlePrompt: string;
  generalGenerationPrompt: string;
  temperature: number;
  maxTokens: number;
}

export const DEFAULT_BRAIN_SETTINGS: BrainSettings = {
  openAIApiKey: '',
  defaultOpenAIModelId: '',
  generateTitlePrompt: `...`,
  generalGenerationPrompt: `You are an AI assistant tasked with continuing and extending the provided note content. Your role is to generate relevant and coherent text that seamlessly follows the given context.

Rules:
- Carefully analyze the context to understand the topic, style, and tone of the note.
- Generate text that naturally flows from the provided context, maintaining consistency in style and content.
- Aim to provide meaningful additions to the note, expanding on key ideas or introducing related concepts.
- Ensure your output is well-structured, clear, and easy to follow.
- Do not introduce any new formatting or markdown syntax not already present in the context.
- Your generation response should be purely the text to be added, without any additional labels or explanations.

Here is the note content to continue, within triple backticks:

\`\`\`
{{context}}
\`\`\``,
  temperature: 0.2,
  maxTokens: 1000,
};
