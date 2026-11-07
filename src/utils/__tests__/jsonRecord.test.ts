import { isRecord } from '../jsonRecord';

it('recognizes non-array objects without changing the shared predicate semantics', () => {
  for (const value of [{}, Object.create(null), new Date(), /record/]) expect(isRecord(value)).toBe(true);
  for (const value of [null, undefined, [], 'object', 1, true, () => ({})]) expect(isRecord(value)).toBe(false);
});
