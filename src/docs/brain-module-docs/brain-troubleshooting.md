---
title: Brain Module - Troubleshooting and FAQ
description: Common issues, troubleshooting steps, and frequently asked questions about the Brain Module in SystemSculpt AI.
index: 5
---

This page covers common issues, troubleshooting steps, and frequently asked questions related to the Brain Module.

## Common Issues and Troubleshooting Steps

If you encounter issues:

1. **API Key Problems**

   - Ensure your API keys are correctly entered and valid
   - Check if you have sufficient credits or subscription for the chosen service

2. **Model Availability**

   - Verify that the selected model is available and supported by your current configuration
   - Check your internet connection for cloud-based models

3. **Local Endpoint Issues**

   - Verify that your local endpoint is running and accessible
   - Ensure you've waited for the plugin to validate and refresh the model list after changing the endpoint

4. **Generation Problems**

   - Try switching between models to see if the issue is model-specific
   - Adjust the max output tokens or temperature settings

5. **Plugin Updates**
   - Ensure you're using the latest version of the plugin
   - Check the changelog for any known issues or recent fixes

## Performance Optimization

To optimize the Brain Module's performance:

1. Keep your list of enabled models manageable
2. Use specific search terms when filtering models
3. Familiarize yourself with keyboard shortcuts for faster navigation
4. Adjust the max output tokens setting to balance between generation speed and output length

## Frequently Asked Questions

1. **Q: Can I use multiple AI models simultaneously?**
   A: While you can't use multiple models at the same time, you can quickly switch between models using the model selection modal or settings.

2. **Q: Is my data safe when using cloud-based AI models?**
   A: Your data is transmitted to the respective AI service providers when using cloud-based models. Review their privacy policies for more information.

3. **Q: How can I optimize the plugin's performance?**
   A: Adjust the max output tokens setting, use local models for faster response times (if available), and ensure a stable internet connection for cloud-based models.

4. **Q: How can I switch between different local LLM providers?**
   A: Change the local endpoint URL in the settings. The plugin will automatically validate the new endpoint and refresh the available models.

5. **Q: What should I do if the model list doesn't update after changing the local endpoint?**
   A: Ensure the new endpoint is online and accessible. Try manually refreshing the AI service through the settings or restart Obsidian. If problems persist, check the console for error messages and report the issue on the plugin's GitHub repository.

## Error Handling

The Brain Module includes several features to handle potential issues:

- Clear error messages for API key problems or unavailable models
- Automatic model fallback if the selected model becomes unavailable
- Graceful degradation when some models or providers are inaccessible

## Reporting Issues

If you encounter a bug or have a feature request:

1. Check the plugin's GitHub repository for known issues
2. Provide detailed information about your setup and the steps to reproduce the issue
3. Include any relevant error messages or screenshots
4. Submit an issue on the GitHub repository or contribute to the project's development

## Configuration Example

Here's an example of optimizing the Brain Module for creative writing:

1. Set temperature to 0.8 for more varied outputs
2. Customize the general generation prompt:

```
You are a creative writing assistant. Continue the story in a vivid and engaging manner, focusing on descriptive language and character development.
```

3. Use a more advanced model like GPT-4o (from OpenAI) or Claude Sonnet 3.5 (via OpenRouter) for complex narrative structures
