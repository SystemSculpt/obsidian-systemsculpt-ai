import { formatReasoningForDisplay } from '../reasoningFormat';

describe('formatReasoningForDisplay', () => {
  it('inserts a blank line before bold headings stuck to preceding text', () => {
    const input = 'Insights.**Searching for Script Patterns**\nNext';
    const output = formatReasoningForDisplay(input);
    expect(output).toBe('Insights.\n\n**Searching for Script Patterns**\nNext');
  });

  it('keeps existing spacing when a newline is already present', () => {
    const input = 'Insights.\n**Searching for Script Patterns**\nNext';
    const output = formatReasoningForDisplay(input);
    expect(output).toBe(input);
  });

  it('does not touch inline bold phrases that are not followed by a newline', () => {
    const input = 'We should keep this **inline bold** intact.';
    const output = formatReasoningForDisplay(input);
    expect(output).toBe(input);
  });

  it('handles multiple stuck headings in a single block', () => {
    const input = 'One!**First Header**\nTwo?**Second Header**\nFinal';
    const output = formatReasoningForDisplay(input);
    expect(output).toBe('One!\n\n**First Header**\nTwo?\n\n**Second Header**\nFinal');
  });

  it('works with Windows line endings', () => {
    const input = 'Intro.**Next Steps**\r\nMore';
    const output = formatReasoningForDisplay(input);
    expect(output).toBe('Intro.\n\n**Next Steps**\r\nMore');
  });
});
