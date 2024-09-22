---
title: Brain Module - Settings and Configuration
description: Detailed information about the settings and configuration options available in the Brain Module of SystemSculpt AI.
index: 3
---

The Brain Module offers various customizable settings to tailor the AI experience to your needs.

## API Endpoint Configuration

Enable or disable different API endpoints:

- OpenAI
- Groq
- OpenRouter
- Local Endpoint

Settings for each endpoint (API keys, local endpoint URL) are only displayed if the corresponding toggle is enabled.

### Local Endpoint Configuration

When changing the local endpoint URL, the plugin automatically validates the new endpoint and refreshes available models if the endpoint is online.

## Key Settings

- **API Keys**: Set up your OpenAI and Groq API keys
- **Local Endpoint**: Configure a local AI endpoint if you're using one
- **Generate Title Prompt**: Customize the prompt used for title generation
- **General Generation Prompt**: Adjust the prompt for text continuation
- **Max Output Tokens**: Set the maximum length of generated text
- **Temperature**: Control the creativity/randomness of the AI output (0.0 to 2.0)

## Status Bar Integration

Customize the information displayed in your Obsidian status bar:

- Current AI Model
- Max Output Tokens

Toggle the display of these items in the settings.

## Temperature Setting

Control the creativity and randomness of AI outputs:

- Adjust the temperature slider from 0.0 to 2.0
- Lower values (0.0 - 0.3) produce more focused, deterministic outputs
- Higher values (0.8 - 2.0) lead to more diverse, creative responses
- A warning is displayed for temperatures at or above 1.0 due to potential for over-creative results

## Settings Search Functionality

The plugin includes a powerful search feature within the settings tab:

- Real-time filtering of settings as you type
- Fuzzy search supporting partial matches
- Multi-term search to narrow down results
- Visual highlighting of matching terms
- Keyboard navigation through search results

### How to Use

1. Open the SystemSculpt settings tab in Obsidian
2. Use the search input field at the top of the settings panel
3. Start typing to search for specific settings across all modules

## Version Checking

The plugin automatically checks for updates by querying the GitHub repository's releases:

1. Fetches the latest release information from the GitHub API
2. Compares the latest version with the currently installed version
3. Displays a notification if an update is available

To update the plugin, use Obsidian's built-in plugin manager. The notification will remind you to update through the Community Plugins section to get the latest features, fixes, and improvements.

## Best Practices

1. Regularly review and update your settings to optimize your workflow
2. Use the settings search functionality to quickly find specific options
3. Experiment with different configurations to find the best setup for your needs

## Security and Privacy Considerations

- API keys are stored locally and never transmitted to third-party servers
- When using local models, your data remains on your device
- For cloud-based models, be aware that prompts and generated content may be transmitted to their servers

For troubleshooting information related to settings and configuration, see the [Troubleshooting and FAQ](brain-troubleshooting) page.
