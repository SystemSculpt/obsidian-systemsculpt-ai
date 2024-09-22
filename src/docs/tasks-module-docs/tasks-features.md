---
title: Tasks Module - Features
description: Detailed information about the key features of the Tasks Module in SystemSculpt AI.
index: 1
---

## AI-Powered Task Generation

The Tasks module uses AI to transform brief task descriptions into well-structured, actionable tasks.

Key aspects:

- Utilizes the Brain module's AI capabilities
- Considers custom task prompts, selected AI model, and generation parameters
- Can generate main tasks with up to 3 subtasks if necessary

## Task Management and Storage

Tasks are stored and managed within a designated Markdown file in your Obsidian vault.

Features:

- Customizable storage location
- Structured task format for easy parsing and management
- Integration with Obsidian's native task handling capabilities

## Quick Task Access

The module provides quick access to task creation and viewing functionalities.

Implementation:

- "T" button on the Obsidian status bar
- Customizable visibility through plugin settings

## Task Structure

Tasks are structured with the following properties:

- Description: The main task description
- Subtasks: An array of up to 3 subtasks, each with its own description and completion status
- Completed: A boolean indicating whether the main task is completed

The AI-powered task generation will create a main task and up to 3 subtasks if necessary, based on the brief description provided by the user. This structure allows for a hierarchical organization of tasks, enhancing task management capabilities.

Example of a generated task structure:

```markdown
- [ ] Main task description
    - [ ] Subtask 1 description
    - [ ] Subtask 2 description
    - [ ] Subtask 3 description
```

This format is compatible with Obsidian's native task handling, allowing for easy integration with existing workflows and task plugins.

## Batch Task Creation

For efficient task management, the module supports batch task creation.

How it works:

- Use Shift+Mod+Enter to add a task and keep the modal open
- Allows for quick successive task creation without reopening the modal

## Task Viewing

Quick access to your task list is provided through a dedicated command.

Access method:

- Use the "View tasks" command (default hotkey: CMD+OPTION+V)
- Opens the task list for easy review and management
