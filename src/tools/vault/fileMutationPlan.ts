export type FileWritePlan = Readonly<{ disposition: 'skip' | 'write'; modifiedContent: string }>;

/** Pure write calculation. I/O, authorization, validation and conflict guards stay with the executor. */
export function planFileWrite(input: Readonly<{
  path: string;
  exists: boolean;
  currentContent?: string;
  content: string;
  ifExists?: string | null;
  appendNewline?: boolean | null;
}>): FileWritePlan {
  const policy = input.ifExists ?? 'overwrite';
  if (input.exists && policy === 'skip') return { disposition: 'skip', modifiedContent: input.currentContent ?? '' };
  if (input.exists && policy === 'error') throw new Error(`File already exists: ${input.path}`);
  if (input.exists && policy === 'append') {
    if (input.currentContent === undefined) throw new Error('Append planning requires the current file content.');
    return {
      disposition: 'write',
      modifiedContent: input.currentContent + (input.appendNewline && !input.currentContent.endsWith('\n') ? '\n' : '') + input.content,
    };
  }
  return { disposition: 'write', modifiedContent: input.content };
}
