import { readStudioCommandExecution, studioAgentExecution } from '../StudioCommandExecution';
import type { StudioNodeInstance } from '../types';
const center = (execution?: unknown) => ({ id: 'center', kind: 'studio.command_center', config: { execution, actions: { items: [{ kind: 'run', target: 'worker' }] } } }) as StudioNodeInstance;
it('defaults to Astra high and overrides priority role/global options for command roles', () => {
  expect(studioAgentExecution([center()], 'worker', { model: 'other', effort: 'low', serviceTier: 'priority' })).toEqual({ model: 'gpt-6-astra', effort: 'high', serviceTier: 'default' });
  expect(studioAgentExecution([center({ model: 'custom-model', effort: 'medium' })], 'worker', { serviceTier: 'fast' })).toEqual({ model: 'custom-model', effort: 'medium', serviceTier: 'default' });
});
it.each([
  [{ model: '', effort: '' }, { model: 'gpt-6-astra', effort: 'high' }],
  [{ model: 'custom', effort: '' }, { model: 'custom', effort: 'high' }],
  [{ model: '', effort: 'low' }, { model: 'gpt-6-astra', effort: 'low' }],
  [{ model: '  ', effort: '\t' }, { model: 'gpt-6-astra', effort: 'high' }],
])('preserves legacy blank Command Center selections: %j', (saved, expected) => {
  expect(readStudioCommandExecution(saved)).toEqual(expected);
  expect(studioAgentExecution([center(saved)], 'worker', {})).toEqual({ ...expected, serviceTier: 'default' });
});
it('inherits the parent launch snapshot even after the selector changes or for another role', () => {
  expect(studioAgentExecution([center({ model: 'changed', effort: 'low' })], 'peer', {}, { model: 'original', effort: 'high', serviceTier: 'priority' })).toEqual({ model: 'original', effort: 'high', serviceTier: 'default' });
});
it('preserves execution settings outside command center roles', () => {
  const fallback = { model: 'custom', effort: 'low', serviceTier: 'default' };
  expect(studioAgentExecution([center()], 'unrelated', fallback)).toEqual(fallback);
  expect(studioAgentExecution([], 'worker', fallback)).toEqual(fallback);
});
it('validates saved settings and ignores any imported service tier', () => {
  expect(() => readStudioCommandExecution({ model: 'valid', effort: 'invalid' })).toThrow();
  expect(() => readStudioCommandExecution({ model: 'bad value', effort: 'high' })).toThrow();
  expect(() => readStudioCommandExecution(null)).toThrow();
  expect(readStudioCommandExecution({ model: 'gpt-6-astra', effort: 'high', serviceTier: 'priority' })).toEqual({ model: 'gpt-6-astra', effort: 'high' });
});
