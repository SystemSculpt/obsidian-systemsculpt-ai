---
title: Tasks Module - Customization
description: Guide to customizing the Tasks Module in SystemSculpt AI to fit your workflow.
index: 3
---

## Customizable Task Prompts

Users can tailor the AI's task generation behavior by customizing the task prompt:

1. Go to plugin settings
2. Under the Tasks section, locate the "Task prompt" text area
3. Modify the prompt to suit your specific needs or preferred task structure

Example custom prompt:

```
Generate a clear, actionable task with up to 3 subtasks if necessary. Format:
- [ ] Main task
    - [ ] Subtask 1
    - [ ] Subtask 2
    - [ ] Subtask 3

Ensure the main task is concise and specific. Subtasks should break down the main task into manageable steps. Only include subtasks if they are necessary for clarity or task completion. Use imperative mood for all task descriptions.
```

This custom prompt encourages the AI to generate well-structured, actionable tasks with appropriate subtasks. You can further customize this prompt to suit your specific task management style or organizational needs.

## Task Storage Location

Customize where your tasks are stored within your Obsidian vault:

1. Go to plugin settings
2. Under the Tasks section, find the "Tasks location" setting
3. Enter your preferred file path (e.g., "Tasks/daily-tasks.md")

## Status Bar Integration

Toggle the visibility of the quick access task button:

1. Go to plugin settings
2. Under the Tasks section, find "Show task button on status bar"
3. Toggle the switch to show or hide the button

## AI Model Configuration

While not directly in the Tasks module settings, you can affect task generation by adjusting Brain module settings:

1. Go to the Brain module settings
2. Modify the default AI model, temperature, and max ouput tokens
3. These changes will be reflected in task generation behavior

## Hotkey Customization

Customize hotkeys for quick access to Tasks module features:

1. Go to Obsidian's Hotkeys settings
2. Search for "SystemSculpt AI" or "Tasks"
3. Assign or modify hotkeys for actions like opening the Task Modal or viewing tasks

## Advanced Customization

For users comfortable with coding, the Tasks module can be further customized:

- Modify the task file format by adjusting the module's file handling logic
- Implement additional task properties by extending the task data structure
- Create custom commands or buttons for specific task-related actions

Note: Advanced customization may require modifying the plugin's source code and should be done cautiously to maintain compatibility with future updates.
