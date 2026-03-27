const sharedAuthState = new Map();

class MockAuthStorageInstance {
  constructor() {
    this.runtimeApiKeys = new Map();
  }

  getOAuthProviders() {
    return [];
  }

  get(provider) {
    return sharedAuthState.get(String(provider || "").trim()) || undefined;
  }

  has(provider) {
    return sharedAuthState.has(String(provider || "").trim());
  }

  hasAuth(provider) {
    return this.has(provider) || this.runtimeApiKeys.has(String(provider || "").trim());
  }

  async getApiKey(provider) {
    const key = String(provider || "").trim();
    return this.runtimeApiKeys.get(key) || this.get(key)?.key || "";
  }

  set(provider, value) {
    sharedAuthState.set(String(provider || "").trim(), value);
  }

  remove(provider) {
    sharedAuthState.delete(String(provider || "").trim());
  }

  list() {
    return Array.from(sharedAuthState.keys()).map((provider) => ({ provider }));
  }

  getAll() {
    return Object.fromEntries(sharedAuthState.entries());
  }

  setRuntimeApiKey(provider, value) {
    this.runtimeApiKeys.set(String(provider || "").trim(), String(value || ""));
  }

  async login(provider, callbacks = {}) {
    callbacks.onProgress?.(`Mock login for ${provider}`);
    callbacks.onAuth?.({ url: "https://example.com/mock-login" });
  }
}

const AuthStorage = {
  create() {
    return new MockAuthStorageInstance();
  },
};

class MockSessionManager {
  constructor(sessionFile, cwd = process.cwd()) {
    this.cwd = cwd;
    this.sessionFile = sessionFile;
    this.sessionId = `sess_${Math.random().toString(36).slice(2, 10)}`;
    this.sessionName = undefined;
  }

  static create(cwd = process.cwd()) {
    return new MockSessionManager(`/tmp/${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`, cwd);
  }

  static open(sessionFile, sessionDir) {
    return new MockSessionManager(sessionFile, sessionDir || process.cwd());
  }

  static inMemory(cwd = process.cwd()) {
    return new MockSessionManager(undefined, cwd);
  }

  static async list() {
    return [];
  }

  getCwd() {
    return this.cwd;
  }

  getSessionDir() {
    return this.cwd;
  }

  getSessionId() {
    return this.sessionId;
  }

  getSessionFile() {
    return this.sessionFile;
  }

  getLeafId() {
    return null;
  }

  getLeafEntry() {
    return undefined;
  }

  getEntry() {
    return undefined;
  }

  getLabel() {
    return undefined;
  }

  getBranch() {
    return [];
  }

  getHeader() {
    return null;
  }

  getEntries() {
    return [];
  }

  getTree() {
    return [];
  }

  appendSessionInfo(name) {
    this.sessionName = name;
    return `entry_${Math.random().toString(36).slice(2, 10)}`;
  }

  getSessionName() {
    return this.sessionName;
  }
}

class MockSettingsManager {
  static create() {
    return new MockSettingsManager();
  }

  static inMemory() {
    return new MockSettingsManager();
  }
}

class ModelRegistry {
  constructor(authStorage) {
    this.authStorage = authStorage;
    this.providers = new Map();
    this.models = [];
  }

  refresh() {}
  getError() { return undefined; }

  getAll() {
    return [...this.models];
  }

  getAvailable() {
    return [...this.models];
  }

  find(provider, modelId) {
    return this.models.find((model) => model.provider === provider && model.id === modelId);
  }

  async getApiKey(model) {
    return this.getApiKeyForProvider(model?.provider);
  }

  async getApiKeyForProvider(provider) {
    if (!this.authStorage || typeof this.authStorage.getApiKey !== "function") {
      return undefined;
    }
    const key = await this.authStorage.getApiKey(provider);
    return key || undefined;
  }

  isUsingOAuth() {
    return false;
  }

  registerProvider(providerName, config = {}) {
    this.providers.set(providerName, config);
    if (Array.isArray(config.models)) {
      this.models = this.models.filter((model) => model.provider !== providerName);
      for (const model of config.models) {
        this.models.push({
          provider: providerName,
          ...model,
        });
      }
    }
  }

  unregisterProvider(providerName) {
    this.providers.delete(providerName);
    this.models = this.models.filter((model) => model.provider !== providerName);
  }
}

function createExtensionRuntime() {
  return {};
}

function createCodingTools() {
  return [];
}

async function createAgentSession(options = {}) {
  const listeners = new Set();
  const sessionManager = options.sessionManager || MockSessionManager.inMemory(options.cwd);
  const session = {
    agent: { state: { messages: [] } },
    sessionManager,
    sessionFile: sessionManager.getSessionFile(),
    sessionId: sessionManager.getSessionId(),
    model: options.model,
    thinkingLevel: "medium",
    state: {
      messages: [],
      model: options.model,
      thinkingLevel: "medium",
      isStreaming: false,
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      listeners.forEach((listener) => listener({ type: "agent_end", messages: [] }));
    },
    async abort() {},
    dispose() {},
    async setModel(model) {
      session.model = model;
      session.state.model = model;
    },
    setThinkingLevel(level) {
      session.thinkingLevel = level;
      session.state.thinkingLevel = level;
    },
    setSessionName(name) {
      sessionManager.appendSessionInfo(name);
    },
    async fork() {
      return { selectedText: "", cancelled: false };
    },
  };

  return {
    session,
    extensionsResult: { extensions: [], errors: [], runtime: createExtensionRuntime() },
  };
}

module.exports = {
  AuthStorage,
  ModelRegistry,
  SessionManager: MockSessionManager,
  SettingsManager: MockSettingsManager,
  createAgentSession,
  createCodingTools,
  createExtensionRuntime,
};
