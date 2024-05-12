import { Setting, ToggleComponent } from 'obsidian';
import { BrainModule } from '../BrainModule';

export function renderAPIEndpointToggles(
  containerEl: HTMLElement,
  plugin: BrainModule,
  onAfterSave: () => void
): void {
  const apiEndpointsContainer = containerEl.createDiv(
    'api-endpoints-container'
  );
  apiEndpointsContainer.createEl('h3', { text: 'API Endpoints' });

  const apiEndpointsList = apiEndpointsContainer.createDiv('model-list');

  const apiEndpoints = [
    { id: 'openAI', name: 'OpenAI' },
    { id: 'groq', name: 'Groq' },
    { id: 'localEndpoint', name: 'Local Endpoint' },
  ];

  apiEndpoints.forEach(endpoint => {
    const apiEndpointItem = apiEndpointsList.createDiv('model-item');
    const apiEndpointName = apiEndpointItem.createDiv('model-name');
    apiEndpointName.setText(endpoint.name);

    const toggleComponent = new ToggleComponent(apiEndpointItem);
    toggleComponent.setValue(plugin.settings[`show${endpoint.id}Setting`]);
    toggleComponent.onChange(async value => {
      plugin.settings[`show${endpoint.id}Setting`] = value;
      await plugin.saveSettings();
      onAfterSave();
      apiEndpointItem.toggleClass('disabled', !value);
    });
  });
}
