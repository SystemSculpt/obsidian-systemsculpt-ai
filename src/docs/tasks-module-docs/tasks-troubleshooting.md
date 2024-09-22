---
title: Tasks Module - Troubleshooting
description: Solutions to common issues and frequently asked questions about the Tasks Module in SystemSculpt AI.
index: 4
---

## Common Issues and Solutions

### Tasks Not Generating

If tasks are not being generated:

1. Ensure your API key is correctly set in the Brain module settings
2. Verify that you have an active internet connection
3. Check if the selected AI model is available and functioning

### Task File Not Found

If you're unable to view or access your tasks:

1. Check that the tasks location in settings points to a valid file path in your vault
2. Ensure you have write permissions for the specified location
3. Try creating the file manually if it doesn't exist

### Incorrect Task Format

If tasks are being generated with unexpected formatting:

1. Review your custom task prompt in the settings
2. Ensure the prompt follows the correct Markdown syntax for tasks
3. Try resetting to the default prompt and gradually customize from there

## Error Handling

The Tasks module includes robust error handling for common issues:

- API key validation: If an invalid API key is detected, users are prompted to update their key in the settings
- Model availability: If the selected model is unavailable, the module attempts to use alternative local or online models
- File system errors: The module handles cases where the tasks file or directory doesn't exist, creating them as needed

## Performance Considerations

To optimize the Tasks module's performance:

1. Ensure a stable internet connection for cloud-based AI models
2. Consider using local AI models if available for faster response times
3. Keep your task list file size manageable by regularly archiving completed tasks

## Frequently Asked Questions

Q: Can I use the Tasks module offline?
A: Task viewing and management work offline, but task generation requires an internet connection for cloud-based AI models.

Q: How can I migrate my existing tasks to the SystemSculpt AI format?
A: The Tasks module uses standard Markdown task syntax. You can manually copy your existing tasks into the designated tasks file.

Q: Is there a limit to how many tasks I can create?
A: There's no hard limit, but very large task files may impact performance. Consider archiving completed tasks regularly.

## Reporting Issues

If you encounter persistent issues or have feature requests:

1. Check the [SystemSculpt GitHub repository](https://github.com/systemsculpt/obsidian-systemsculpt-ai) for known issues
2. Provide detailed information about your setup and steps to reproduce the issue
3. Include relevant error messages or screenshots
4. Submit an issue on the GitHub repository or reach out through the community Discord

Remember to keep your plugin updated to the latest version, as many issues are resolved with updates.
