export interface Model {
  id: string;
  name: string;
  description?: string;
  isLocal?: boolean; // Flag to determine if the model is a local model
}
