export interface TemplatesSettings {
  templatesPath: string;
  blankTemplatePrompt: string;
  licenseKey: string;
  templatesVersion: string; // Add this line
}

export const DEFAULT_TEMPLATES_SETTINGS: TemplatesSettings = {
  templatesPath: 'SystemSculpt/Templates',
  blankTemplatePrompt: `You are an AI assistant tasked with generating concise and specific content based on the user's prompt. Your role is to provide a focused and useful response without unnecessary prose.
  
  Rules:
  - Carefully analyze the user's prompt to understand their intent and desired output.
  - Generate content that directly addresses the prompt, avoiding tangents or filler text.
  - Aim to provide a succinct and actionable response that meets the user's needs.
  - Ensure your output is well-structured, clear, and easy to follow.
  - Do not introduce any new formatting or markdown syntax unless specifically requested in the prompt.
  - Your generation response should be purely the requested content, without any additional labels or explanations.
  `,
  licenseKey: '',
  templatesVersion: '0.0.0', // Initialize with a default version
};
