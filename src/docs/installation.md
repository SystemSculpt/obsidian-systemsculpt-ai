---
title: Installation
description: Learn how to install and set up SystemSculpt AI, an all-in-one AI-powered plugin for Obsidian.
index: 1
---

## Installation Steps

1. Open Obsidian and go to Settings > Community Plugins.
2. Disable Safe Mode if it's enabled.
3. Click on "Browse" and search for "SystemSculpt AI".
4. Click "Install" next to the SystemSculpt AI plugin.
5. Once installed, enable the plugin by toggling the switch next to its name.

Alternatively, you can install the plugin directly from the Obsidian Community Plugins Marketplace [by clicking here](https://obsidian.md/plugins?id=systemsculpt-ai).

## Post-Installation Setup

After installing SystemSculpt AI, you'll need to configure various settings to get the most out of the plugin's multiple modules:

### Brain Module Configuration

1. Go to Settings > SystemSculpt AI > Brain.
2. Configure API keys for the AI services you plan to use:
   - Get your OpenAI API key [here](https://platform.openai.com/api-keys)
   - Get your Groq API key [here](https://console.groq.com/keys)
   - Get your OpenRouter API key [here](https://openrouter.ai/keys)
   - or use your own local endpoint - [learn more](/docs/local-endpoint)
3. Choose your default AI model from the available options.
4. Adjust the [max output tokens](/docs/max-tokens) and [temperature](/docs/temperature) settings to your preference.
5. Customize the generate title prompt and general generation prompt if desired.
6. Configure API endpoints as needed (OpenAI, Groq, OpenRouter, Local Endpoint).

### Chat Module Setup

1. In the Chat Module section of the settings:
   - Set the "Chats folder location" to your preferred path (default is "SystemSculpt/Chats")
   - Customize the "System Prompt" if desired
   - Toggle "Show chat button on status bar" based on your preference

### Recorder Module Configuration

1. In the Recorder Module settings:
   - Set the storage locations for recordings and transcriptions
   - Choose your preferred microphone
   - Select the Whisper provider (OpenAI or Groq) for transcription

### Templates Module Setup

1. In the Templates Module settings:
   - Set the templates folder location
   - Configure template syncing options (if you have a license key)

### Tasks Module Configuration

1. In the Tasks Module settings:
   - Set the tasks storage location
   - Customize the task generation prompt if desired

## Verifying Installation

To ensure SystemSculpt AI is properly installed and configured:

1. Look for the SystemSculpt AI icons in your Obsidian ribbon (chat, recorder, etc.).
2. Try using features from each module:
   - Open a new chat
   - Record a quick audio note
   - Generate a template
   - Create an AI-powered task
3. Check the status bar for quick access buttons and AI model information.

## Troubleshooting

If you encounter any issues during installation or setup:

1. Verify that your Obsidian version is compatible with SystemSculpt AI.
2. Ensure all API keys are correctly entered in the Brain module settings.
3. Check your internet connection for cloud-based features.
4. Consult the [Troubleshooting](troubleshooting) guide for common issues and solutions.

## Updating SystemSculpt AI

The plugin will automatically check for updates. When a new version is available:

1. Go to Settings > Community Plugins.
2. Click on "Check for updates".
3. If an update is available for SystemSculpt AI, click "Update".

Remember to review the changelog for any new features or breaking changes after updating. Mike regularly updates the plugin based on user feedback and new ideas.

## Next Steps

After installation, explore the various modules and features of SystemSculpt AI:

- Use the Brain module to generate titles or continue text in your notes.
- Start AI-powered chat conversations with the Chat module.
- Record and transcribe audio notes using the Recorder module.
- Create AI-generated tasks from quick notes with the Tasks module.
- Experiment with AI-powered templates for your notes using the Templates module.

For detailed information on each module and its features, refer to the respective module documentation in the SystemSculpt AI plugin settings or the [Features](features) page.
