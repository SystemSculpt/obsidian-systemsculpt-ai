---
title: Templates Module - Customization
description: Guide to customizing the Templates Module in SystemSculpt AI to fit your workflow.
index: 3
---

## Customizing Template Generation

1. Adjust AI model settings:

   - Go to plugin settings > Templates
   - Select your preferred AI model
   - Adjust max output tokens and other generation parameters

2. Customize the blank template prompt:
   - Modify the default prompt in the settings
   - Tailor it to your specific content generation needs

## Creating Custom Templates

You can create your own templates to use with the SystemSculpt AI plugin. Here's how to do it:

1. Navigate to your templates folder:

   - By default, this is set to "Templates" in your Obsidian vault
   - You can change this location in the plugin settings under "Template folder location"

2. Create a new markdown file in this folder (e.g., "meeting-notes.md")

3. Add frontmatter to the top of the file. The frontmatter should be enclosed in triple dashes (---) and include the following fields:

```yaml
---
name: Meeting Notes
description: Template for taking structured meeting notes
model: gpt-4
max tokens: 500
tags: meeting, notes, productivity
---
```

4. Below the frontmatter, add your template content and any AI prompts you want to use.

Here's an example template you can use as a starting point:

```markdown
---
name: Project Kickoff Meeting
description: Template for documenting project kickoff meetings
model: gpt-4
max tokens: 800
tags: project, meeting, kickoff
---

# Project Kickoff Meeting: {{project_name}}

Date: {{date}}
Attendees: {{attendees}}

## Agenda

1. Project Overview
2. Goals and Objectives
3. Timeline and Milestones
4. Team Roles and Responsibilities
5. Next Steps

## Notes

[AI Assistant, please help me summarize the key points discussed in each agenda item based on the meeting notes I provide below.]

### 1. Project Overview

### 2. Goals and Objectives

### 3. Timeline and Milestones

### 4. Team Roles and Responsibilities

### 5. Next Steps

## Action Items

[AI Assistant, based on the notes above, please generate a list of action items, including responsible person and due date where applicable.]

- [ ]
- [ ]
- [ ]

## Follow-up Questions

[AI Assistant, please suggest 3-5 follow-up questions or topics that might need clarification based on the meeting notes.]

1.
2.
3.
```

Note: You can leave the `model` field empty in the frontmatter if you want to use the current default model selected in the plugin settings. For example:

```yaml
---
name: Quick Note
description: Template for quick notes and ideas
max tokens: 300
tags: quick, note, idea
---
```

By leaving the `model` field empty, the template will use whatever model is currently set as the default in the Brain module settings.

Remember to adjust the `max tokens` value based on the expected length of your generated content and the capabilities of the chosen model.

## Customizing Template Suggestions

1. Set a custom trigger key:

   - Go to plugin settings > Templates
   - Modify the "Template trigger" setting

2. Adjust suggestion behavior:
   - Configure whether to include synced templates in suggestions
   - Set up any exclusion rules for specific templates or folders

## Configuring Template Syncing

1. Enable template syncing:

   - Go to plugin settings > Templates
   - Toggle "Enable template syncing"

2. Enter your license key for access to synced templates

3. Customize sync settings:
   - Set sync frequency (default is every 3 hours)
   - Choose whether to include synced templates in suggestions

## Setting Up Custom Triggers and Hotkeys

1. Go to Obsidian's Hotkeys settings
2. Search for "SystemSculpt AI" or "Templates"
3. Assign or modify hotkeys for actions like:
   - Opening the blank template modal
   - Triggering template suggestions
   - Manually syncing templates

## Advanced Customization

For users comfortable with coding:

- Modify the template file format by adjusting the module's file handling logic
- Implement additional template properties by extending the frontmatter schema
- Create custom commands or buttons for specific template-related actions

Note: Advanced customization may require modifying the plugin's source code and should be done cautiously to maintain compatibility with future updates.

## Performance Tuning

1. Optimize template library:

   - Keep templates focused and concise
   - Use subfolders to organize templates efficiently

2. Adjust AI model settings:

   - Lower max tokens for faster generation
   - Use local models when possible for lower latency

3. Fine-tune sync settings:
   - Adjust sync frequency based on your needs
   - Selectively sync only necessary templates

For troubleshooting information and FAQs, please refer to the [Troubleshooting](templates-troubleshooting) document.
