---
title: Templates Module - Troubleshooting and FAQ
description: Solutions to common issues and frequently asked questions about the Templates Module in SystemSculpt AI.
index: 4
---

## Common Issues and Solutions

### Templates Not Appearing in Suggestions

1. Verify your templates folder is correctly set in settings
2. Ensure templates have the required frontmatter
3. Check if the template trigger key is set correctly

### AI Generation Not Working

1. Verify your API key and model settings in the Brain module
2. Check your internet connection for online models
3. Ensure the selected model is available and functioning

### Syncing Issues

1. Confirm your license key is valid and entered correctly
2. Check your internet connection
3. Try manually triggering a sync from the settings

## Error Handling

The Templates module includes robust error handling for common issues:

- Clear error messages for API key problems or generation failures
- Automatic retry for failed sync attempts
- Graceful degradation when certain features are unavailable

## Performance Considerations

To optimize the Templates module's performance:

1. Keep your template library organized and avoid an excessive number of templates
2. Use local models when possible for lower latency
3. Adjust max output tokens and other generation parameters for faster results

## Frequently Asked Questions

Q: Can I use my own AI models with the Templates module?
A: Yes, you can configure custom AI models in the plugin settings, including local models.

Q: How often are synced templates updated?
A: By default, the module checks for updates every 3 hours, but you can manually sync anytime.

Q: Is an internet connection required to use templates?
A: Only for online AI models and template syncing. Local templates and models work offline.

Q: How can I create a custom template?
A: Create a new markdown file in your templates folder, add the necessary frontmatter, and write your template content.

Q: Can I use different AI models for different templates?
A: Yes, you can specify the AI model to use in each template's frontmatter.

## Reporting Issues

If you encounter persistent issues or have feature requests:

1. Check the [SystemSculpt GitHub repository](https://github.com/systemsculpt/obsidian-systemsculpt-ai) for known issues
2. Provide detailed information about your setup and steps to reproduce the issue
3. Include relevant error messages or screenshots
4. Submit an issue on the GitHub repository or reach out through the community Discord

Remember to keep your plugin updated to the latest version, as many issues are resolved with updates.

## Glossary of Terms

- Frontmatter: YAML metadata at the beginning of a markdown file
- AI Model: The artificial intelligence model used for generating content
- Template Sync: The process of updating templates from a central server
- Trigger Key: The character or sequence that activates template suggestions

For customization options and advanced settings, please refer to the [Customization](templates-customization) document.
