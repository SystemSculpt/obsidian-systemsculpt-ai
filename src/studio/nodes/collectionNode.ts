import type { StudioNodeDefinition } from "../types";
import { readCollectionField, readStudioCollection } from "../StudioCollection";

export const collectionNode: StudioNodeDefinition = {
  kind: 'studio.collection', version: '1.0.0', requiredHostCapabilities: [], capabilityClass: 'local_cpu', cachePolicy: 'by_inputs',
  inputPorts: [{ id: 'json', type: 'json', required: false }], outputPorts: [{ id: 'json', type: 'json' }],
  configDefaults: { value: { items: [] }, itemsPath: 'items', groupBy: 'status', groupFields: { Status: 'status' }, showClosed: true },
  configSchema: { fields: [
    { key: 'value', label: 'Collection data', type: 'json_object' },
    { key: 'itemsPath', label: 'Items path', type: 'text' },
    { key: 'groupBy', label: 'Group by field', type: 'text' },
    { key: 'groupFields', label: 'Available grouping fields', type: 'json_object' },
    { key: 'columnOrder', label: 'Column order by field', type: 'json_object' },
    { key: 'showClosed', label: 'Show completed and canceled', type: 'boolean' },
    { key: 'idField', label: 'ID field', type: 'text' },
    { key: 'titleField', label: 'Title field', type: 'text' },
    { key: 'subtitleField', label: 'Subtitle field', type: 'text' },
    { key: 'urlField', label: 'Link field', type: 'text' },
    { key: 'parentField', label: 'Parent field', type: 'text' },
    { key: 'resourcesField', label: 'Linked resources field', type: 'text' },
    { key: 'descriptionField', label: 'Description field', type: 'text' },
    { key: 'commentsField', label: 'Discussion field', type: 'text' },
    { key: 'freshnessSeconds', label: 'Mark source stale after (seconds)', type: 'number', min: 30, max: 604800, integer: true },
    { key: 'sourceWorkspace', label: 'Connected source workspace', type: 'text' },
    { key: 'closedField', label: 'Closed state field', type: 'text' },
    { key: 'closedValues', label: 'Closed values, comma separated', type: 'text' },
  ], allowUnknownKeys: false },
  async execute(context) {
    const value = context.node.config.value;
    const data = readCollectionField(value, 'source.schema') === 'studio.source.v1' ? value : context.inputs.json ?? value ?? { items: [] };
    readStudioCollection(data, context.node.config);
    return { outputs: { json: data } };
  },
};
