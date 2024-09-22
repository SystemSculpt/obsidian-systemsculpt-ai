---
title: Recorder Module - Troubleshooting and FAQ
description: Common issues, troubleshooting steps, and frequently asked questions about the Recorder Module in SystemSculpt AI.
index: 4
---

This page covers common issues, troubleshooting steps, and frequently asked questions related to the Recorder Module.

## Common Issues and Troubleshooting Steps

### Recording Issues

1. **Recording fails to start**

   - Ensure microphone permissions are correctly set in your operating system.
   - Try selecting a different microphone in the Recorder settings.
   - Restart Obsidian and try again.

2. **No audio input detected**
   - Check if your microphone is properly connected and recognized by your system.
   - Verify that the correct microphone is selected in the Recorder settings.

### Transcription Issues

1. **Transcription not working**

   - Verify your OpenAI or Groq API key (depending on your selected provider) in the Brain settings.
   - Check your internet connection, as transcription requires online access.
   - Ensure you've selected the correct Whisper provider in the Recorder settings.

2. **Inaccurate transcriptions**
   - Try using a different Whisper model (for OpenAI).
   - Ensure your audio quality is clear and free from background noise.
   - For non-English recordings, check if the selected model supports your language.

### Integration Issues

1. **Transcriptions not appearing in active note**

   - Ensure the "Paste into active note" option is enabled in the settings.
   - Make sure you have an active note open when the transcription completes.

2. **Status bar button not visible**
   - Check if it's enabled in the Recorder settings under "Show recorder button on status bar".

## Performance Considerations

- Transcription speed depends on your internet connection and the API's response time.
- Large audio files may take longer to transcribe and could impact Obsidian's performance temporarily.
- Consider disabling "Save audio clips" if you're only interested in transcriptions to save disk space.

## Frequently Asked Questions

1. **Q: Can I use the Recorder module offline?**
   A: You can record audio offline, but transcription requires an internet connection.

2. **Q: What audio file formats are supported for existing file transcription?**
   A: Currently, the module supports .mp3 files for transcription of existing files.

3. **Q: How can I improve transcription accuracy?**
   A: Use a good quality microphone, speak clearly, minimize background noise, and experiment with different Whisper models.

4. **Q: Is there a limit to the length of recordings I can transcribe?**
   A: The module automatically splits large audio files into chunks, so theoretically, there's no limit. However, very long recordings may take significant time to process.

5. **Q: Are my recordings and transcriptions private?**
   A: Audio recordings are stored locally in your Obsidian vault. Transcription requests are sent to the chosen AI service (OpenAI or Groq) using your API key. No data is stored on SystemSculpt's servers.

## Error Handling

The Recorder Module includes several features to handle potential issues:

- Clear error messages for API key problems or transcription failures.
- Automatic retry for failed transcription attempts.
- Graceful degradation when transcription services are unavailable.

## Reporting Issues

If you encounter a bug or have a feature request:

1. Check the plugin's GitHub repository for known issues.
2. Provide detailed information about your setup and the steps to reproduce the issue.
3. Include any relevant error messages or logs.
4. Submit an issue on the GitHub repository or contribute to the project's development.

Remember to always keep your plugin and Obsidian up to date, and regularly check for announcements or known issues on our website or GitHub repository.
