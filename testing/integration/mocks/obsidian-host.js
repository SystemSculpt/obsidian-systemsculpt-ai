/**
 * Enriched Obsidian host mock for the built-bundle integration suite.
 *
 * Extends the unit-test mock (src/tests/mocks/obsidian.js) with the plugin
 * persistence surface (`loadData`/`saveData`) and any host APIs the compiled
 * bundle touches during onload that unit tests never exercise. Keep additions
 * minimal and explicit — a missing export failing loudly here is the signal
 * this suite exists to produce.
 */
const YAML = require("yaml");
const base = require("../../../src/tests/mocks/obsidian.js");

class IntegrationApp extends base.App {
  constructor() {
    super();
    this.metadataCache.on = jest.fn(() => ({ unload: jest.fn() }));
    this.workspace.iterateAllLeaves = jest.fn();
    this.workspace.requestSaveLayout = jest.fn();
  }
}

// Obsidian's View supplies these defaults, and the bundle's views call super.setState.
class IntegrationItemView extends base.ItemView {
  getState() {
    return {};
  }

  async setState() {}
}

class IntegrationPlugin extends base.Plugin {
  constructor(app, manifest) {
    super(app, manifest);
    this._data = null;
  }

  async loadData() {
    return this._data;
  }

  async saveData(data) {
    this._data = data;
  }

  async onExternalSettingsChange() {}
}

module.exports = {
  ...base,
  // Match manifest.minAppVersion so artifact smoke tests exercise the normal
  // installed-plugin lifecycle instead of the old-host recovery path.
  apiVersion: "1.7.2",
  App: IntegrationApp,
  ItemView: IntegrationItemView,
  Plugin: IntegrationPlugin,
  // Saved chats keep their identity in YAML frontmatter.
  parseYaml: (text) => YAML.parse(text),
  stringifyYaml: (value) => YAML.stringify(value),
};
