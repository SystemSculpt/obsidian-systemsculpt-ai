---
title: Troubleshooting
description: Comprehensive guide to resolving common issues with SystemSculpt AI's multiple modules.
index: 3
---

If you encounter any issues with SystemSculpt AI, this troubleshooting guide will help you diagnose and resolve common problems across all modules. If you can't find a solution here, please contact our support team.

## General Issues

### Plugin Not Working

1. Ensure that the plugin is enabled in Obsidian:

   - Go to Settings > Community Plugins
   - Find SystemSculpt AI in the list
   - Make sure the toggle switch is turned on

2. Check if Obsidian is up to date:

   - SystemSculpt AI may require a recent version of Obsidian
   - Update Obsidian if necessary

3. Try restarting Obsidian:
   - Sometimes, a simple restart can resolve plugin issues

### Features Not Available

1. Verify you have the latest version of SystemSculpt AI:

   - Go to Settings > Community Plugins
   - Click "Check for updates"
   - Update SystemSculpt AI if a new version is available

2. Check the plugin's changelog for any feature changes or deprecations

## Brain Module Issues

### API Key Not Valid

1. Double-check your API keys:

   - Go to Settings > SystemSculpt AI > Brain
   - Verify the API keys for OpenAI, Groq, and OpenRouter are entered correctly without any extra spaces

2. Ensure you're using the correct API key for each service

3. Check if your API keys have expired or been revoked:
   - Log into your accounts on the respective AI service websites
   - Verify the status of your API keys

### No Models Detected

1. Verify API endpoints are enabled:

   - Go to Settings > SystemSculpt AI > Brain
   - Check if the toggles for OpenAI, Groq, OpenRouter, or Local Endpoint are turned on

2. For local models:

   - Ensure your local endpoint URL is correct
   - Verify that your local model server is running

3. Check your internet connection for cloud-based models

### Generation Issues

1. Title or text generation not working:
   - Verify the max output tokens setting is appropriate for your task
   - Check the temperature setting - lower values (0.0 - 0.3) for more focused outputs
   - Ensure the generate title prompt and general generation prompt are configured correctly

## Chat Module Issues

1. Chat not loading:

   - Check your internet connection
   - Verify that the selected AI model is available

2. High token count:

   - Consider starting a new chat
   - Adjust the max output tokens setting in the Brain module

3. Context not working:
   - Ensure the selected context files are accessible in your vault
   - Check if the context files are in a supported format

## Recorder Module Issues

1. Recording fails:

   - Check microphone permissions for Obsidian in your OS settings
   - Try selecting a different microphone in the Recorder settings

2. Transcription issues:
   - Verify your OpenAI or Groq API key (depending on your selected provider)
   - Ensure you have a stable internet connection
   - Check if the selected Whisper model is available

## Templates Module Issues

1. Templates not appearing in suggestions:

   - Check if your templates folder is set correctly in settings
   - Verify that templates have the required frontmatter

2. Syncing issues:

   - Confirm your license key is valid and entered correctly
   - Try manually triggering a sync from the settings

3. AI generation for templates not working:
   - Ensure the Brain module is properly configured with valid API keys
   - Check if the selected AI model for template generation is available

## Tasks Module Issues

1. Tasks not generating:

   - Ensure your API key is correctly set in the Brain module settings
   - Check that the tasks location in settings points to a valid file path in your vault

2. Task formatting issues:
   - Review your custom task prompt in the settings
   - Try resetting to the default prompt and gradually customize from there

## Performance Issues

1. Slow response times:

   - Consider using a faster AI model
   - Adjust the max output tokens setting to a lower value
   - For local models, check your system resources

2. High CPU or memory usage:
   - Close other resource-intensive applications
   - Consider using cloud-based models instead of local ones if resources are limited

## Logging and Debugging

To help diagnose issues:

1. Enable debug logging:

   - Go to Settings > SystemSculpt AI > About
   - Toggle on "Enable debug logging"

2. Reproduce the issue

3. Check the console log:
   - Use Ctrl+Shift+I (Windows/Linux) or Cmd+Option+I (Mac) to open the developer tools
   - Navigate to the Console tab
   - Look for any error messages or warnings related to SystemSculpt AI

## Contacting Support

If you've tried the above solutions and are still experiencing issues:

1. Gather relevant information:

   - SystemSculpt AI version
   - Obsidian version
   - Operating system
   - Steps to reproduce the issue
   - Any error messages or logs

2. Contact Mike for support:

   - Email: support@systemsculpt.com
   - Discord: Join the community server and post in the #support channel

3. Consider checking or posting on the [GitHub Issues](https://github.com/systemsculpt/obsidian-systemsculpt-ai/issues) page for the plugin

Mike, as the solo developer, actively monitors these channels and will do his best to assist you.

Remember to always keep your plugin and Obsidian up to date, and regularly check for announcements or known issues on our website or GitHub repository.
