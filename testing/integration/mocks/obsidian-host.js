/**
 * Enriched Obsidian host mock for the built-bundle integration suite.
 *
 * Extends the unit-test mock (src/tests/mocks/obsidian.js) with the plugin
 * persistence surface (`loadData`/`saveData`) and any host APIs the compiled
 * bundle touches during onload that unit tests never exercise. Keep additions
 * minimal and explicit — a missing export failing loudly here is the signal
 * this suite exists to produce.
 */
const base = require("../../../src/tests/mocks/obsidian.js");

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
  Plugin: IntegrationPlugin,
};
