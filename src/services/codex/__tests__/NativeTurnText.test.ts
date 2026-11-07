import { NativeTurnText } from '../NativeTurnText';

describe('native turn text projection', () => {
  it('keeps absolute offsets after the rolling presentation buffer fills', () => {
    const emit = jest.fn();
    const text = new NativeTurnText({ mode: 'offsets', snapshot: 'rolling' }, emit);
    text.append('a'.repeat(256_010));
    text.append('tail');
    text.complete('corrected');
    text.append('next');
    text.complete('next');
    expect(emit.mock.calls.map(([value, offset]) => [value.length, offset])).toEqual([
      [256_010, 0], [4, 256_010], [9, 0], [6, 9], [6, 9],
    ]);
    expect(text.text).toBe('corrected\n\nnext');
    text.reset();
    text.append('fresh');
    expect(emit).toHaveBeenLastCalledWith('fresh', 0);
  });

  it.each(['rolling', 'joined-segments'] as const)('preserves %s snapshot projection and canonical tail replacement', snapshot => {
    const emit = jest.fn();
    const text = new NativeTurnText({ mode: 'snapshot', snapshot }, emit);
    text.append('draft');
    text.complete('canonical');
    text.append('next');
    text.complete('NEXT');
    expect(emit.mock.calls).toEqual([['draft'], ['canonical'], ['canonical\n\nnext'], ['canonical\n\nNEXT']]);
  });

  it('retracts only an identified partial suffix using absolute coordinates', () => {
    const emit = jest.fn();
    const text = new NativeTurnText({ mode: 'offsets', snapshot: 'joined-segments' }, emit);
    text.complete('before');
    text.append('genuine output');
    text.append('notice');
    text.retractPartial(6);
    expect(text.partialText).toBe('genuine output');
    expect(text.partialLength).toBe(14);
    expect(emit).toHaveBeenLastCalledWith('', 22);
    text.reset();
    expect(text.text).toBe('');
    expect(text.partialText).toBe('');
    expect(text.partialLength).toBe(0);
  });
});
