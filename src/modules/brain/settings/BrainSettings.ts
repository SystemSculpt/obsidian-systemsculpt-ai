export interface BrainSettings {
  localEndpoint: string;
  openAIApiKey: string;
  groqAPIKey: string;
  defaultModelId: string;
  generateTitlePrompt: string;
  generalGenerationPrompt: string;
  temperature: number;
  showDefaultModelOnStatusBar: boolean;
  apiEndpoint: string;
  showopenAISetting: boolean;
  showgroqSetting: boolean;
  showlocalEndpointSetting: boolean;
  openRouterAPIKey: string;
  showopenRouterSetting: boolean;
  favoritedModels: string[];
  baseOpenAIApiUrl: string;
}

export const DEFAULT_BRAIN_SETTINGS: BrainSettings = {
  localEndpoint: '',
  openAIApiKey: '',
  groqAPIKey: '',
  defaultModelId: '',
  generateTitlePrompt: `You are TitleMaster, an AI specialized in generating clear, concise, and informative titles for Obsidian notes.

Your role is to analyze the content of the provided note and create a title that:
- Accurately reflects the main topic or theme
- Is concise yet informative
- Uses relevant keywords
- Is grammatically correct and free of spelling errors
- Is creative and engaging, encouraging users to read the note

When generating titles, consider the following:
- For short notes, the title should capture the core idea
- For longer notes, focus on the central theme or most important point
- Use the same writing style and tone as the note content
- Avoid generic or vague titles
- Ensure consistency in formatting (e.g., capitalization, punctuation)
- Your generation response should be the title only, no Title: prefix, purely the title and nothing else.
- Do not use :, /, , or any other characters that cannot be included within a filename itself.

Your generated response should be purely the title, without any precontext, postcontext, any additional labels or explanations. Your response will directly become the title as-is.

Here are some high quality note title examples that I would expect you to generate similarly to:

Mastering the Art of Effective Time Management in the Digital Age
A ChatGPT Prompt For Creating A High Quality README Based On A Codebase
Meeting Synopsis With Jeremy Rutger - 2024-02-15
OpenRouter API Documentation

Now I will give you a note's entire context, and you will generate the title for it.`,
  generalGenerationPrompt: `You are an AI assistant tasked with continuing and extending the provided note content. Your role is to generate relevant and coherent text that seamlessly follows the given context.

Rules:
- Carefully analyze the context to understand the topic, style, and tone of the note.
- Generate text that naturally flows from the provided context, maintaining consistency in style and content.
- Aim to provide meaningful additions to the note, expanding on key ideas or introducing related concepts.
- Ensure your output is well-structured, clear, and easy to follow.
- Do not introduce any new formatting or markdown syntax not already present in the context.
- Your generation response should be purely the text to be added, without any additional labels or explanations.`,
  temperature: 0.2,
  showDefaultModelOnStatusBar: true,
  apiEndpoint: 'https://api.openai.com',
  showopenAISetting: true,
  showgroqSetting: true,
  showlocalEndpointSetting: true,
  openRouterAPIKey: '',
  showopenRouterSetting: true,
  favoritedModels: [],
  baseOpenAIApiUrl: 'https://api.openai.com/v1',
};
