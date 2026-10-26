import { defaultTextBackend, localTextAgent } from '../CodexExecutionSettings';
import { hasHostCapability } from '../../../platform/hostCapabilities';
jest.mock('../../../platform/hostCapabilities', () => ({ hasHostCapability: jest.fn(() => true) }));

it('selects an on-machine agent on desktop', () => {
  expect(localTextAgent({ textExecutionBackend: 'claude' })).toBe('claude');
  expect(defaultTextBackend({ textExecutionBackend: 'claude' })).toBe('claude');
  expect(localTextAgent({ textExecutionBackend: 'codex' })).toBe('codex');
  expect(defaultTextBackend({ textExecutionBackend: 'codex' })).toBe('codex');
  expect(localTextAgent({ textExecutionBackend: 'unknown' as never })).toBeNull();
});
it.each(['codex', 'claude'] as const)('falls back to SystemSculpt API on mobile when %s is selected', backend => {
  jest.mocked(hasHostCapability).mockReturnValueOnce(false);
  expect(defaultTextBackend({ textExecutionBackend: backend })).toBe('systemsculpt');
});
