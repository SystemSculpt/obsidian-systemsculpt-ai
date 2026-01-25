import { DEFAULT_SETTINGS, SystemSculptSettings } from '../types';
import { API_BASE_URL } from '../constants/api';

type PartialPlugin = {
  settings: SystemSculptSettings;
  customProviderService: Record<string, unknown>;
  app: any;
  emitter: { emitWithProvider: jest.Mock };
};

const createPlugin = (overrides: Partial<SystemSculptSettings> = {}): PartialPlugin => {
  const settings: SystemSculptSettings = {
    ...DEFAULT_SETTINGS,
    licenseKey: 'test-license',
    licenseValid: true,
    serverUrl: overrides.serverUrl ?? DEFAULT_SETTINGS.serverUrl,
    enableSystemSculptProvider: true,
    ...overrides,
  } as SystemSculptSettings;

  return {
    settings,
    customProviderService: {},
    app: {},
    emitter: { emitWithProvider: jest.fn() },
  };
};

jest.mock('../services/StreamingService', () => ({
  StreamingService: jest.fn().mockImplementation(() => ({
    resetThinkingState: jest.fn(),
    processStreamChunk: jest.fn(),
    processStreamLine: jest.fn(),
    handleStreamEvent: jest.fn(),
    generateRequestId: jest.fn(() => 'req-1'),
    handleStreamError: jest.fn(),
  })),
}));

jest.mock('../services/LicenseService', () => ({
  LicenseService: jest.fn().mockImplementation(() => ({
    updateBaseUrl: jest.fn(),
    validateLicense: jest.fn().mockResolvedValue(true),
  })),
}));

jest.mock('../services/ModelManagementService', () => ({
  ModelManagementService: jest.fn().mockImplementation(() => ({
    updateBaseUrl: jest.fn(),
    getModelInfo: jest.fn().mockResolvedValue({ isCustom: false, provider: null, actualModelId: 'test-model', upstreamModelId: 'test-model' }),
    getModels: jest.fn().mockResolvedValue([]),
    preloadModels: jest.fn(),
  })),
}));

jest.mock('../services/ContextFileService', () => ({
  ContextFileService: jest.fn().mockImplementation(() => ({
    prepareMessagesWithContext: jest.fn(),
  })),
}));

jest.mock('../services/DocumentUploadService', () => ({
  DocumentUploadService: jest.fn().mockImplementation(() => ({
    updateConfig: jest.fn(),
    uploadDocument: jest.fn(),
  })),
}));

jest.mock('../services/AudioUploadService', () => ({
  AudioUploadService: jest.fn().mockImplementation(() => ({
    updateBaseUrl: jest.fn(),
    uploadAudio: jest.fn(),
  })),
}));

jest.mock('../views/chatview/MCPService', () => ({
  MCPService: jest.fn().mockImplementation(() => ({
    getAvailableTools: jest.fn().mockResolvedValue([]),
  })),
}));

const { SystemSculptService } = require('../services/SystemSculptService');

describe('SystemSculptService base URL resolution', () => {
  afterEach(() => {
    SystemSculptService.clearInstance();
    jest.clearAllMocks();
  });

  it('defaults to API_BASE_URL when settings serverUrl is empty', () => {
    const plugin = createPlugin({ serverUrl: '' });
    const service = SystemSculptService.getInstance(plugin as any);
    expect(service.baseUrl).toBe(API_BASE_URL);
  });

  it('corrects marketing domain to API subdomain', () => {
    const plugin = createPlugin({ serverUrl: 'https://systemsculpt.com' });
    const service = SystemSculptService.getInstance(plugin as any);
    expect(service.baseUrl).toBe('https://api.systemsculpt.com/api/v1');
  });

  it('normalizes www marketing domain to API subdomain', () => {
    const plugin = createPlugin({ serverUrl: 'https://www.systemsculpt.com/' });
    const service = SystemSculptService.getInstance(plugin as any);
    expect(service.baseUrl).toBe('https://api.systemsculpt.com/api/v1');
  });
});
