---
title: Tasks Module - Overview
description: An introduction to the Tasks module, its purpose, and key components in the SystemSculpt AI plugin for Obsidian.
index: 0
---

The Tasks module is a powerful component of the SystemSculpt plugin for Obsidian. It leverages AI to help users generate, manage, and organize tasks within their Obsidian vault. This module streamlines the process of creating actionable items from quick notes or ideas, enhancing productivity and note organization.

## Purpose

The primary purpose of the Tasks module is to:

- Generate well-structured, actionable tasks from brief descriptions
- Manage and organize tasks within the Obsidian environment
- Enhance productivity and streamline task management workflows

## Key Components

1. **AI-Powered Task Generation**: Utilizes AI models to create clear, actionable tasks from brief descriptions, including up to 3 subtasks if necessary.
2. **Task Management and Storage**: Organizes and stores tasks in a designated Markdown file within the Obsidian vault.
3. **Quick Task Access**: Provides easy access to task creation and viewing through status bar integration and command palette.
4. **Customizable Task Prompts**: Allows users to tailor the AI's task generation behavior to their specific needs.
5. **Batch Task Creation**: Enables users to create multiple tasks in succession without closing the task modal.

## Integration with Other Modules

The Tasks module integrates closely with the Brain module, utilizing its AI capabilities for task generation. This integration ensures consistent AI performance across the plugin's features and allows for dynamic model selection based on availability.

## Task Structure

Tasks are structured with the following properties:
- Description: The main task description
- Subtasks: An array of up to 3 subtasks, each with its own description and completion status
- Completed: A boolean indicating whether the main task is completed

This structure allows for a hierarchical organization of tasks, enhancing task management capabilities.
