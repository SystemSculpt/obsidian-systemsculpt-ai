import { sanitizeTextForApi } from '../embeddings/providers/systemSculptSanitizer';

describe('systemSculptSanitizer', () => {
  it('redacts high-entropy blobs and rewrites WAF-heavy terms', () => {
    const blob = `${'A'.repeat(210)}==`;
    const sanitized = sanitizeTextForApi(`Run phpunit with blob ${blob}`);

    expect(sanitized).toContain('test runner');
    expect(sanitized).not.toContain('phpunit');
    expect(sanitized).toMatch(/\[base64:\d+\]/);
    expect(sanitized).not.toContain(blob);
  });

  it('defangs traversal patterns including encoded variants', () => {
    const input = '%252e%252e%252fetc/passwd and ../../secret';
    const sanitized = sanitizeTextForApi(input);

    expect(sanitized).not.toMatch(/%252e%252e/i);
    expect(sanitized).not.toMatch(/\.\.(?:\/|\\)/);
    expect(sanitized).toContain('parent/');
  });

  it('keeps normal text readable', () => {
    const input = 'Use curl to fetch docs, then summarize results for testing.';
    const sanitized = sanitizeTextForApi(input);

    expect(sanitized).toContain('http client');
    expect(sanitized).toContain('summarize results for testing');
  });
});
