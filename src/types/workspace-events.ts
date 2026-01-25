/**
 * Type definitions for custom workspace events
 */

import { SystemSculptSettings } from '../types';

export interface SystemSculptWorkspaceEvents {
  'systemsculpt:settings-loaded': (settings: SystemSculptSettings) => void;
  'systemsculpt:settings-updated': (oldSettings: SystemSculptSettings, newSettings: SystemSculptSettings) => void;
  'systemsculpt:license-validated': (isValid: boolean) => void;
  'systemsculpt:embeddings-progress': (progress: { current: number; total: number }) => void;
  'systemsculpt:chat-created': (chatId: string) => void;
  'systemsculpt:chat-closed': (chatId: string) => void;
  'systemsculpt:chat-loaded': (chatId: string) => void;
  'systemsculpt:content-rendered': () => void;
  'systemsculpt:settings-focus-tab': (tabId: string) => void;
}

// Module augmentation to add our custom events to Obsidian's workspace
declare module 'obsidian' {
  interface Workspace {
    trigger<K extends keyof SystemSculptWorkspaceEvents>(
      name: K,
      ...args: Parameters<SystemSculptWorkspaceEvents[K]>
    ): void;
    
    on<K extends keyof SystemSculptWorkspaceEvents>(
      name: K,
      callback: SystemSculptWorkspaceEvents[K],
      ctx?: any
    ): EventRef;
  }
}
