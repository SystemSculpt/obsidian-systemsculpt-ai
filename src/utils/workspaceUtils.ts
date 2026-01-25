import { App, normalizePath, WorkspaceLeaf, TFile, Platform, Notice } from 'obsidian';
import { displayNotice } from '../core/ui/notifications';

/**
 * Find an existing leaf for a file path across all windows and tabs.
 * This function iterates through all leaves and prioritizes returning a markdown view
 * if multiple leaves match the same file path (e.g., markdown view and outline view).
 *
 * @param app The application instance.
 * @param path The normalized path of the file to find.
 * @returns The WorkspaceLeaf if found, otherwise null.
 */
export function findLeafByPath(app: App, path: string): WorkspaceLeaf | null {
  const matchingLeaves: WorkspaceLeaf[] = [];

  app.workspace.iterateAllLeaves((leaf) => {
    const view = leaf.view as any;
    const state = leaf.getViewState();

    // A leaf's file path can be in one of two places:
    // 1. `view.file.path` for fully loaded/active leaves.
    // 2. `state.state.file` for lazy-loaded leaves after a restart.
    const pathFromView = view.file ? normalizePath(view.file.path) : null;
    const pathFromState = (state.state && typeof state.state.file === 'string') ? normalizePath(state.state.file) : null;
    const leafPath = pathFromView || pathFromState;
    
    if (leafPath && leafPath === path) {
      matchingLeaves.push(leaf);
    }
  });

  if (matchingLeaves.length === 0) {
    return null;
  }

  // Prioritize the markdown view, which is the main editor content
  const markdownLeaf = matchingLeaves.find(leaf => leaf.getViewState().type === 'markdown');
  
  if (markdownLeaf) {
    return markdownLeaf;
  }
  
  // Fallback to the first match if no markdown view is found
  return matchingLeaves[0];
}

/**
 * Opens a file in the main workspace area, avoiding sidebars.
 * It will first try to open in an existing pane. If no suitable pane exists,
 * it will create a new split intelligently.
 *
 * @param app The application instance.
 * @param filePath The path of the file to open.
 * @returns A promise that resolves with an object containing the leaf and the action taken.
 */
export async function openFileInMainWorkspace(
  app: App,
  filePath: string
): Promise<{
  leaf: WorkspaceLeaf | null;
  action: 'switched_in_pane' | 'focused_other_pane' | 'created_new' | 'error';
}> {
  const normalizedPath = normalizePath(filePath);
  const file = app.vault.getAbstractFileByPath(normalizedPath);
  const currentLeaf = app.workspace.activeLeaf;

  if (!file) {
    return { leaf: null, action: 'error' };
  }

  if (!(file instanceof TFile)) {
    return { leaf: null, action: 'error' };
  }

  const existingFileLeaf = findLeafByPath(app, normalizedPath);

  // Case 1: File is open in the same tab group. Switch to it and give it focus.
  if (existingFileLeaf && currentLeaf && existingFileLeaf.parent === currentLeaf.parent) {
    app.workspace.setActiveLeaf(existingFileLeaf, { focus: true });
    displayNotice(app, {
      title: 'Switched to tab',
      path: normalizedPath
    });
    return { leaf: existingFileLeaf, action: 'switched_in_pane' };
  }

  // Case 2: File is open, but in a different pane/window. Focus it without keyboard focus.
  if (existingFileLeaf) {
    app.workspace.setActiveLeaf(existingFileLeaf, { focus: false });
    displayNotice(app, {
      title: 'Focused existing tab',
      path: normalizedPath,
      message: 'File is in another pane/window.'
    });
    return { leaf: existingFileLeaf, action: 'focused_other_pane' };
  }
  
  // Case 3: File is not open. Create a new leaf for it.
  else {
    let targetLeaf: WorkspaceLeaf | null = null;
    let noticeTitle = '';
    let noticeMessage = '';

    if (Platform.isMobile) {
      targetLeaf = app.workspace.getLeaf('tab');
      noticeTitle = 'Opened in new tab';
    } else {
      let suitablePane: WorkspaceLeaf | null = null;
      app.workspace.iterateAllLeaves(leaf => {
        if (leaf.getRoot() === app.workspace.rootSplit && leaf !== currentLeaf) {
          if (!suitablePane) suitablePane = leaf;
        }
      });

      if (suitablePane) {
        app.workspace.setActiveLeaf(suitablePane, { focus: false });
        targetLeaf = app.workspace.getLeaf('tab');
        noticeTitle = 'Opened in new tab';
        noticeMessage = 'Added to an existing pane in the main workspace.';
      } else {
        if (currentLeaf && currentLeaf.getRoot() === app.workspace.rootSplit) {
          targetLeaf = app.workspace.createLeafBySplit(currentLeaf, 'vertical', true);
          noticeTitle = 'Opened in new split';
          noticeMessage = 'Created a side-by-side view with the chat.';
        } else {
          targetLeaf = app.workspace.getLeaf(true);
          noticeTitle = 'Opened in new pane';
          noticeMessage = 'Created a new pane in the main workspace.';
        }
      }
    }

    if (targetLeaf) {
      await targetLeaf.openFile(file);
      displayNotice(app, {
        title: noticeTitle,
        path: normalizedPath,
        message: noticeMessage
      });
      return { leaf: targetLeaf, action: 'created_new' };
    }
  }

  return { leaf: null, action: 'error' };
} 