jest.mock('../../utils/TokenCounter', () => ({
  tokenCounter: {
    truncateToTokenLimit: (text: string) => text,
    estimateTokens: () => 100,
  },
}));

jest.mock('../../utils/httpClient', () => {
  const actual = jest.requireActual('../../utils/httpClient');
  return {
    ...actual,
    httpRequest: jest.fn(),
    isHostTemporarilyDisabled: jest.fn(),
  };
});

import { SystemSculptProvider } from '../embeddings/providers/SystemSculptProvider';
import { httpRequest, isHostTemporarilyDisabled } from '../../utils/httpClient';

const httpRequestMock = httpRequest as jest.MockedFunction<typeof httpRequest>;
const isHostTemporarilyDisabledMock = isHostTemporarilyDisabled as jest.MockedFunction<typeof isHostTemporarilyDisabled>;

describe('SystemSculptProvider gateway handling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-09-19T00:00:00Z'));
    httpRequestMock.mockReset();
    isHostTemporarilyDisabledMock.mockReset();
    isHostTemporarilyDisabledMock.mockReturnValue({ disabled: false, retryInMs: 0 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('short-circuits when host circuit breaker is open before starting a request', async () => {
    isHostTemporarilyDisabledMock.mockReturnValue({ disabled: true, retryInMs: 2 * 60 * 1000 });

    const provider = new SystemSculptProvider('test-license');

    await expect(provider.generateEmbeddings(['hello world']))
      .rejects.toMatchObject({
        code: 'HOST_UNAVAILABLE',
        retryInMs: 2 * 60 * 1000,
        transient: true,
      });
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

});
