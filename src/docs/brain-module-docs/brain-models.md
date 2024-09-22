---
title: Brain Module - AI Models and Selection
description: Detailed information about AI model management, selection, and usage in the Brain Module of SystemSculpt AI.
index: 2
---

The Brain Module supports various AI models and provides flexible options for model selection and management.

## Supported Model Types

1. OpenAI models
2. Groq models
3. OpenRouter models
4. Local models through Ollama or LM Studio

## Model Selection Modal

The Model Selection Modal offers a quick and efficient way to switch between different AI models.

### How to Use

- Open the modal using the assigned hotkey (recommended: CMD+M)
- Use the search bar to filter models in real-time
- Navigate through models using keyboard arrows or Tab/Shift+Tab
- Select a model by clicking, pressing Enter, or using keyboard shortcuts

### Features

- Fuzzy multi-term search
- Real-time filtering
- Keyboard navigation
- Visual highlighting of search terms
- Grouped display by provider
- Automatic selection of the first model after search
- Keyboard shortcuts for quick selection

## Model Fallback Behavior

When selecting a model, the plugin follows this order:

1. Default model set in settings
2. First available local model
3. First available online model (OpenAI, Groq, or OpenRouter)

If no models are available, "No Models Detected" will be displayed.

## Performance Considerations

- Local models may require significant computational resources
- Cloud-based models depend on internet connection speed
- Adjust max output tokens setting to balance generation speed and output length

## Best Practices

1. Experiment with different models to find the best fit for your tasks
2. Use hotkeys for quick model switching
3. Regularly update the plugin to access new models and improvements
