---
title: Brain Module - Features and Usage
description: Detailed information about the key features of the Brain Module and how to use them effectively.
index: 1
---

# Features and Usage

The Brain Module offers several AI-powered features to enhance your note-taking and writing experience in Obsidian.

## Title Generation

Automatically generate titles for your notes based on their content.

### How to Use

1. Place your cursor in a note
2. Use the command "Generate title for current note" (recommended hotkey: CMD+Shift+T)
3. The plugin will analyze your note's content and suggest an appropriate title

## Text Continuation

Let the AI continue writing from where you left off in your notes.

### How to Use

1. Place your cursor at the end of your text
2. Use the command "Toggle general generation" (recommended hotkey: CMD+Shift+G)
3. The AI will generate a continuation based on your note's context

### Generation Process

- A "Generating..." notice will be displayed during the process
- You can stop generation at any time using the "Stop all generation processes" command
- The plugin uses streaming response to display generated text in real-time

## Temperature Control

Adjust the temperature setting to control the creativity and randomness of the AI output.

- Low temperature (0.0 - 0.3): More consistent and predictable outputs
- Medium temperature (0.4 - 0.7): Balance between consistency and creativity
- High temperature (0.8 - 2.0): More diverse and unexpected outputs

## Max Output Tokens Adjustment

Quickly adjust the max output tokens setting using a dedicated modal (recommended hotkey: CMD+Shift+M).

## Use Cases

- Academic Writing: Generate titles for research papers and continue drafts
- Content Creation: Generate blog post ideas and expand on outlines
- Note-Taking: Summarize meeting notes and generate action items
- Creative Writing: Get inspiration for story continuations and character descriptions

## Best Practices

1. Customize generation prompts for more tailored results
2. Use hotkeys for quick access to features
3. Adjust temperature and max output tokens settings based on your task
4. Experiment with different models for various writing styles
5. Utilize the model selection modal for quick model switching

## Advanced Features

### Abort Generation

You can stop the generation process at any time:

1. Use the "Stop all generation processes" command
2. A notice will appear confirming the generation has been stopped

### Favoriting Models

You can mark models as favorites for quicker access:

1. Open the Model Selection Modal
2. Click the star icon next to a model to favorite/unfavorite it
3. Favorited models will appear at the top of the list

### API Endpoint Management

Enable or disable different API endpoints:

1. Go to Brain module settings
2. Use the toggles under "API Endpoints" to enable/disable OpenAI, Groq, OpenRouter, or Local endpoints
3. The plugin will automatically update available models based on enabled endpoints

### Model Favoriting

You can mark models as favorites for quicker access:

1. Open the Model Selection Modal
2. Click the star icon next to a model to favorite/unfavorite it
3. Favorited models will appear at the top of the list for easier selection

### Model Selection Modal

The Model Selection Modal provides a quick way to switch between AI models. Use the assigned hotkey (recommended: CMD+M) to open the modal and select a model using keyboard shortcuts or mouse clicks.

### Max Output Tokens Modal

Quickly adjust the max output tokens setting using a dedicated modal (recommended hotkey: CMD+Shift+M) to fine-tune the length of generated content on the fly.

## Limitations

- Quality of generated content depends on the chosen AI model and input provided
- Very long documents may need to be split into smaller chunks due to token limits
- Local models may have limited capabilities compared to cloud-based options
