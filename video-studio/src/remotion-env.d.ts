declare module "*.css";

declare module "@plugin-ui/createInputUI" {
  export function createChatComposer(parent: HTMLElement, deps: any): any;
}

declare module "@plugin-ui/ContextSelectionModal" {
  export class ContextSelectionModal {
    constructor(app: any, onSelect: (files: any[]) => void, plugin: any, options?: any);
    modalEl: HTMLDivElement;
    onOpen(): void;
    [key: string]: any;
  }
}

declare module "@plugin-ui/InlineCollapsibleBlock" {
  export function createInlineBlock(options: any): HTMLElement;
  export function getBlockContent(block: HTMLElement): HTMLElement | null;
  export function setExpanded(block: HTMLElement, expanded: boolean): void;
  export function setStreaming(block: HTMLElement, streaming: boolean): void;
}

declare module "@plugin-ui/CitationFooter" {
  export function renderCitationFooter(contentEl: HTMLElement, citations: readonly any[]): void;
}

declare module "@plugin-ui/ChatStatusSurface" {
  export function renderChatStatusSurface(
    container: HTMLElement,
    spec: {
      eyebrow: string;
      title: string;
      description: string;
      chips: readonly Array<{ label: string; value: string; icon: string }>;
      actions: readonly Array<{
        label: string;
        icon: string;
        primary?: boolean;
        title?: string;
        onClick?: () => void | Promise<void>;
      }>;
      note?: string;
    },
    options?: {
      registerDomEvent?: (
        el: HTMLElement,
        type: keyof HTMLElementEventMap | string,
        callback: (event: Event) => void
      ) => void;
    }
  ): void;
}

declare module "@plugin-ui/ChatComposerIndicators" {
  export function renderChatModelIndicator(
    target: HTMLElement,
    options: {
      selectedModelId?: string | null;
      labelOverride?: string;
    }
  ): {
    ariaLabel: string;
    title: string;
    currentModelName: string;
    isEmpty: boolean;
  };

  export function renderChatPromptIndicator(
    target: HTMLElement,
    options: {
      promptType?: string | null;
      promptPath?: string | null;
      labelOverride?: string;
    }
  ): {
    ariaLabel: string;
    title: string;
    promptLabel: string;
  };

  export function renderChatCreditsIndicator(
    target: HTMLElement,
    options: {
      balance?: {
        totalRemaining: number;
        includedRemaining: number;
        includedPerMonth: number;
        addOnRemaining: number;
        cycleEndsAt?: string;
      } | null;
      titleOverride?: string;
    }
  ): {
    title: string;
    isLoading: boolean;
    isLow: boolean;
  };
}

declare module "@plugin-ui/ContextAttachmentPills" {
  export function renderContextAttachmentPill(
    pill: HTMLElement,
    spec:
      | {
          kind: "file";
          wikiLink: string;
          linkText: string;
          label: string;
          icon: string;
          title?: string;
          removeAriaLabel?: string;
        }
      | {
          kind: "processing";
          processingKey: string;
          linkText: string;
          label: string;
          icon: string;
          title?: string;
          statusIcon?: string;
          spinning?: boolean;
          removeAriaLabel?: string;
        }
  ): void;
}

declare module "@plugin-ui/MessageGrouping" {
  export function appendMessageToGroupedContainer(
    container: HTMLElement | DocumentFragment,
    messageEl: HTMLElement,
    role: "assistant" | "user" | "system" | "tool",
    options?: {
      breakGroup?: boolean;
    }
  ): {
    groupEl: HTMLElement;
    isNewGroup: boolean;
  };
}

declare module "@plugin-ui/MessageRenderer" {
  export class MessageRenderer {
    constructor(app: any);
    getApp(): any;
    renderMessageParts(
      messageEl: HTMLElement,
      message: any,
      isActivelyStreaming?: boolean
    ): void | Promise<void>;
    renderCitations(contentEl: HTMLElement, citations: readonly any[]): void;
  }
}

declare module "@plugin-ui/SystemSculptSearchModal" {
  export class SystemSculptSearchModal {
    constructor(plugin: any);
    modalEl: HTMLDivElement;
    onOpen(): void;
    onClose(): void;
    [key: string]: any;
  }
}

declare module "@plugin-ui/SystemSculptHistoryModal" {
  export class SystemSculptHistoryModal {
    constructor(plugin: any, options?: any);
    modalEl: HTMLDivElement;
    onOpen(): Promise<void>;
    onClose(): void;
    [key: string]: any;
  }
}

declare module "@plugin-ui/CreditsBalanceModal" {
  export class CreditsBalanceModal {
    constructor(app: any, options: any);
    modalEl: HTMLDivElement;
    onOpen(): void;
    onClose(): void;
    [key: string]: any;
  }
}

declare module "@plugin-ui/EmbeddingsStatusModal" {
  export class EmbeddingsStatusModal {
    constructor(app: any, plugin: any);
    modalEl: HTMLDivElement;
    onOpen(): Promise<void>;
    onClose(): void;
    [key: string]: any;
  }
}

declare module "@plugin-ui/BenchResultsView" {
  export class BenchResultsView {
    constructor(leaf: any, plugin: any);
    containerEl: HTMLDivElement;
    [key: string]: any;
  }
}
