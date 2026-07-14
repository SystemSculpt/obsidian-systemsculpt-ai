import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function listCssFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? listCssFiles(absolute) : [absolute];
  }).filter((file) => file.endsWith(".css"));
}

function readCssDirectory(relativeDirectory) {
  return listCssFiles(path.join(root, relativeDirectory))
    .sort()
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
}

function listProductionTypeScript(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : listProductionTypeScript(absolute);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [absolute]
      : [];
  });
}

test("the CSS manifest imports every shipped sheet exactly once", () => {
  const cssRoot = path.join(root, "src", "css");
  const manifest = read("src/css/index.css");
  const imports = [...manifest.matchAll(/@import\s+["']([^"']+)["'];/g)]
    .map((match) => path.normalize(match[1]));
  const expected = listCssFiles(cssRoot)
    .filter((file) => file !== path.join(cssRoot, "index.css"))
    .map((file) => path.relative(cssRoot, file))
    .sort();

  assert.deepEqual([...new Set(imports)].sort(), expected);
  assert.equal(imports.length, new Set(imports).size, "CSS imports must not be duplicated");
});

test("Studio CSS stays feature-owned, bounded, and explicitly ordered", () => {
  const studioRoot = path.join(root, "src", "css", "views", "studio");
  const manifest = read("src/css/index.css");
  const modules = [
    "theme.css",
    "workspace.css",
    "connections.css",
    "node-chrome.css",
    "media-nodes.css",
    "node-runtime.css",
    "groups.css",
    "text-nodes.css",
    "menus.css",
    "editor-preview.css",
    "editor-text.css",
    "editor-json.css",
    "editor-notes.css",
    "editor-dropdowns.css",
    "editor-media.css",
    "caption-board.css",
    "editor-responsive.css",
    "inline-config.css",
    "node-details.css",
  ];
  const actual = listCssFiles(studioRoot).map((file) => path.basename(file)).sort();

  assert.deepEqual(actual, [...modules].sort());
  assert.equal(fs.existsSync(path.join(root, "src/css/views/studio.css")), false);
  assert.equal(fs.existsSync(path.join(root, "src/css/views/studio-editors.css")), false);

  let previousImport = -1;
  for (const module of modules) {
    const statement = `@import 'views/studio/${module}';`;
    const position = manifest.indexOf(statement);
    assert.ok(position > previousImport, `${statement} must preserve the Studio cascade order`);
    previousImport = position;

    const lineCount = read(`src/css/views/studio/${module}`).split(/\r?\n/).length;
    assert.ok(lineCount <= 400, `${module} must stay a bounded component stylesheet`);
  }
});

test("Agent workspace CSS stays feature-owned, bounded, and explicitly ordered", () => {
  const workspaceRoot = path.join(root, "src", "css", "views", "agent-workspace");
  const manifest = read("src/css/index.css");
  const modules = [
    "shell.css",
    "conversation.css",
    "reasoning.css",
    "tools.css",
    "states.css",
    "composer.css",
  ];
  const actual = listCssFiles(workspaceRoot).map((file) => path.basename(file)).sort();

  assert.deepEqual(actual, [...modules].sort());
  assert.equal(fs.existsSync(path.join(root, "src/css/views/agent-workspace.css")), false);

  let previousImport = -1;
  for (const module of modules) {
    const statement = `@import 'views/agent-workspace/${module}';`;
    const position = manifest.indexOf(statement);
    assert.ok(position > previousImport, `${statement} must preserve the Agent workspace cascade order`);
    previousImport = position;

    const lineCount = read(`src/css/views/agent-workspace/${module}`).split(/\r?\n/).length;
    assert.ok(lineCount <= 400, `${module} must stay a bounded component stylesheet`);
  }
});

test("every discoverable Obsidian host mounts a direct or named deep surface adapter", () => {
  const sourceRoot = path.join(root, "src");
  const candidates = listProductionTypeScript(sourceRoot)
    .map((file) => ({ file, source: fs.readFileSync(file, "utf8") }))
    .filter(({ source }) => /extends\s+(?:ItemView|PluginSettingTab|SuggestModal)\b/.test(source));
  const deepAdapters = new Map([
    ["src/views/EmbeddingsView.ts", {
      mount: /new SimilarNotesPresentation\(/,
      adapter: "src/views/SimilarNotesPresentation.ts",
      contract: /applyPluginSurface\(this\.element,\s*"view"\)/,
    }],
    ["src/views/chatview/AgentChatView.ts", {
      mount: /new AgentWorkspace\(/,
      adapter: "src/views/chatview/AgentWorkspace.ts",
      contract: /applyPluginSurface\(this\.element,\s*"view"\)/,
    }],
  ]);

  assert.ok(candidates.length >= 5, "host discovery unexpectedly found too few Obsidian hosts");
  for (const { file, source } of candidates) {
    const relative = path.relative(root, file);
    if (/applyPluginSurface\(/.test(source)) continue;
    const adapter = deepAdapters.get(relative);
    assert.ok(adapter, `${relative} needs a direct surface mount or named deep adapter`);
    assert.match(source, adapter.mount, `${relative} must mount ${adapter.adapter}`);
    assert.match(read(adapter.adapter), adapter.contract, `${adapter.adapter} must mount its canonical surface`);
  }

  const composedContracts = [
    ["src/core/ui/modals/standard/StandardModal.ts", /applyPluginSurface\(this\.modalEl,\s*"modal"\)/],
    ["src/core/ui/progress/OperationProgressPanel.ts", /applyPluginSurface\(this\.root,\s*"transient"\)/],
    ["src/components/HoverShell.ts", /applyPluginSurface\(root,\s*"transient"\)/],
    ["src/modals/BulkAutomationConfirmModal.ts", /new OperationProgressPanel\(\{/],
  ];
  for (const [file, pattern] of composedContracts) {
    assert.match(read(file), pattern, `${file} must mount its named surface adapter`);
  }
});

test("the shared surface owns adaptation and obsolete UI seams stay deleted", () => {
  const surfaceCss = read("src/css/foundation/surface.css");
  const tokensCss = read("src/css/foundation/tokens.css");
  assert.match(surfaceCss, /container:\s*ss-surface\s*\/\s*inline-size/);
  assert.match(surfaceCss, /prefers-contrast:\s*more/);
  assert.match(surfaceCss, /prefers-reduced-motion:\s*reduce/);
  assert.match(surfaceCss, /@media\s*\(pointer:\s*coarse\)[\s\S]*?--ss-control-height:\s*var\(--ss-touch-target\)[\s\S]*?--ss-control-height-sm:\s*var\(--ss-touch-target\)/);
  assert.match(surfaceCss, /:focus-visible/);
  assert.match(surfaceCss, /\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/s);
  assert.match(tokensCss, /--ss-text-base:\s*var\(--font-ui-small,\s*13px\)/);
  assert.match(tokensCss, /--ss-text-(?:xs|lg):\s*calc\(var\(--ss-text-base\)\s*\*/);

  for (const removed of [
    "src/core/ui/components/Button.ts",
    "src/core/ui/components/LoadingIndicator.ts",
    "src/core/ui/services/KeyboardNavigationService.ts",
    "src/core/ui/modals/PopupModal.ts",
    "src/views/chatview/ChatView.ts",
    "src/modals/EmbeddingsStatusModal.ts",
    "src/css/modals/embeddings-status.css",
    "src/css/components/embeddings-status-bar.css",
    "src/core/plugin/FileExplorerStudioButtonManager.ts",
    "src/core/plugin/__tests__/file-explorer-studio-button.test.ts",
    "src/css/components/resume-chat.css",
  ]) {
    assert.equal(fs.existsSync(path.join(root, removed)), false, `${removed} must stay deleted`);
  }

  const production = [
    ...fs.readdirSync(path.join(root, "src", "components"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => read(`src/components/${entry.name}`)),
    read("src/css/index.css"),
  ].join("\n");
  assert.doesNotMatch(production, /useFloatingLegacyClass|systemsculpt-floating-widget/);

  const productionTypeScript = listProductionTypeScript(path.join(root, "src"))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  assert.doesNotMatch(productionTypeScript, /showPopup|PopupComponent|chatview\/ChatView/);

  const statusBar = read("src/components/EmbeddingsStatusBar.ts");
  const plugin = read("src/main.ts");
  assert.match(statusBar, /plugin\.addStatusBarItem\(\)/);
  assert.match(statusBar, /this\.statusBarEl\.setText\(value\)/);
  assert.doesNotMatch(statusBar, /applyPluginSurface|setIcon|ss-embeddings-status-bar/);
  assert.match(plugin, /Platform\.isDesktop\s*&&\s*!this\.embeddingsStatusBar/);
  assert.doesNotMatch(read("src/css/index.css"), /embeddings-status-bar\.css/);

  const resumeChat = read("src/views/chatview/ResumeChatService.ts");
  assert.match(resumeChat, /view\.addAction\("message-circle",\s*"Resume this chat"/);
  assert.doesNotMatch(resumeChat, /\.cm-editor|insertBefore\(|createUiAction/);
  assert.doesNotMatch(read("src/css/index.css"), /resume-chat\.css/);

  const contextMenu = read("src/context-menu/FileContextMenuService.ts");
  assert.match(contextMenu, /file instanceof TFolder/);
  assert.match(contextMenu, /createStudioProjectInFolder/);
  assert.doesNotMatch(contextMenu, /setUseNativeMenu\(/);
  assert.doesNotMatch(contextMenu, /addSeparator\(/);
  assert.doesNotMatch(contextMenu, /setSection\("(?:systemsculpt|system)"\)/);
  assert.match(contextMenu, /setSection\("action"\)/);
  assert.doesNotMatch(productionTypeScript, /workspace-leaf-content\[data-type=["']file-explorer/);

  const searchModal = read("src/modals/SystemSculptSearchModal.ts");
  const searchCss = read("src/css/modals/search.css");
  assert.match(searchModal, /this\.addTitle\("Search your vault"\)/);
  assert.doesNotMatch(searchModal, /ss-search-open|ownerDocument\.body\.classList/);
  assert.doesNotMatch(searchCss, /body\.ss-search-open|\.tooltip/);
  assert.match(searchCss, /@media\s*\(max-width:\s*700px\),\s*\(pointer:\s*coarse\)[\s\S]*?\.ss-modal__header\s*\{[\s\S]*?display:\s*block/);
  assert.match(searchCss, /@media\s*\(max-width:\s*700px\),\s*\(pointer:\s*coarse\)[\s\S]*?\.ss-modal__footer\s*\{[\s\S]*?display:\s*none/);
});

test("StandardModal owns close and reopen invalidation for async feature adapters", () => {
  const standardModal = read("src/core/ui/modals/standard/StandardModal.ts");
  assert.match(standardModal, /protected beginAsyncTask\(key: string\): ModalAsyncTaskScope/);
  assert.match(standardModal, /this\.asyncTaskControllers\.get\(key\)\?\.abort\(\)/);
  assert.match(standardModal, /this\.invalidateAsyncTasks\(\)/);

  for (const file of [
    "src/views/history/SystemSculptHistoryModal.ts",
    "src/modals/EmbeddingsPendingFilesModal.ts",
    "src/modals/AutomationBacklogModal.ts",
    "src/modals/CreditsBalanceModal.ts",
    "src/modals/JanitorModal.ts",
    "src/modals/RecorderAdvancedModal.ts",
  ]) {
    assert.match(read(file), /this\.beginAsyncTask\(/, `${file} must use the shared modal task scope`);
  }

  assert.doesNotMatch(read("src/modals/JanitorModal.ts"), /scanGeneration/);
  assert.doesNotMatch(read("src/modals/AutomationBacklogModal.ts"), /loadGeneration/);
});

test("feature modals stay behind the shared modal interface", () => {
  const modalFiles = listProductionTypeScript(path.join(root, "src"))
    .filter((file) => file.endsWith("Modal.ts"));
  const expectedNativeSuggestModal = path.join(root, "src", "modals", "AutomationRunnerModal.ts");
  const sharedBase = path.join(root, "src", "core", "ui", "modals", "standard", "StandardModal.ts");

  assert.ok(modalFiles.length >= 15, "modal discovery unexpectedly found too few feature modules");
  for (const file of modalFiles) {
    if (file === sharedBase) continue;
    const source = fs.readFileSync(file, "utf8");
    const relative = path.relative(root, file);

    if (file === expectedNativeSuggestModal) {
      assert.match(source, /class\s+AutomationRunnerModal\s+extends\s+SuggestModal\b/);
      assert.doesNotMatch(source, /extends\s+(?:Modal|StandardModal)\b/);
      continue;
    }

    assert.match(
      source,
      /class\s+\w*Modal\s+extends\s+StandardModal\b/,
      `${relative} must compose the shared modal interface`,
    );
    assert.doesNotMatch(source, /extends\s+Modal\b/, `${relative} must not bypass StandardModal`);
  }
});

test("microphone discovery has one owner-realm and lifecycle seam", () => {
  const catalog = read("src/services/recorder/MicrophoneDeviceCatalog.ts");
  const modal = read("src/modals/RecorderAdvancedModal.ts");
  const settings = read("src/settings/RecorderTabContent.ts");
  const settingsHost = read("src/settings/SystemSculptSettingTab.ts");

  assert.match(catalog, /this\.ownerNavigator\.mediaDevices/);
  assert.match(catalog, /mediaDevices\.enumerateDevices\(\)/);
  assert.match(catalog, /mediaDevices\.getUserMedia\(\{ audio: true \}\)/);
  assert.match(catalog, /this\.stopStream\(stream\)/);
  assert.match(catalog, /generation === this\.generation/);

  for (const [file, source] of [
    ["RecorderAdvancedModal.ts", modal],
    ["RecorderTabContent.ts", settings],
  ]) {
    assert.match(source, /getSurfaceOwnerWindow\(/, `${file} must resolve its mounted owner realm`);
    assert.match(source, /new MicrophoneDeviceCatalog\(/, `${file} must use the shared catalog`);
    assert.doesNotMatch(source, /enumerateDevices|getUserMedia/, `${file} must not duplicate device discovery`);
    assert.doesNotMatch(source, /\bnavigator\.mediaDevices|\bwindow\.navigator/, `${file} must not use a global realm`);
  }

  assert.match(modal, /this\.beginAsyncTask\("microphone-devices"\)/);
  assert.match(settings, /tabInstance\.registerRenderCleanup\(/);
  assert.match(settings, /activeRecorderTabRenders\.get\(tabInstance\)\?\.dispose\(\)/);
  assert.match(settingsHost, /registerRenderCleanup\(cleanup: \(\) => void\)/);
  assert.ok(
    [...settingsHost.matchAll(/this\.invalidateRenderCleanups\(\)/g)].length >= 2,
    "settings rerender and hide must both invalidate registered work",
  );
});

test("Janitor owns one typed confirmation-list implementation", () => {
  const janitor = read("src/modals/JanitorModal.ts");
  const confirmation = read("src/modals/JanitorConfirmationListModal.ts");

  assert.match(janitor, /new JanitorConfirmationListModal\(/);
  assert.doesNotMatch(
    janitor,
    /class (?:ConfirmationModal|EmptyContentConfirmationModal)|calculateSize/,
  );
  assert.match(confirmation, /export interface ConfirmationListGroup/);
  assert.match(confirmation, /private resolver: \(\(confirmed: boolean\) => void\) \| null/);
  assert.equal(
    [...confirmation.matchAll(/private resolver:/g)].length,
    1,
    "Janitor confirmation promise ownership must stay singular",
  );
});

test("the deep combobox interface owns interaction for dissimilar feature adapters", () => {
  const combobox = read("src/core/ui/surface/SurfaceCombobox.ts");
  const history = read("src/views/history/SystemSculptHistoryModal.ts");
  const studio = read("src/views/studio/StudioSearchableDropdown.ts");
  const vaultSearch = read("src/modals/SystemSculptSearchModal.ts");
  const settings = read("src/settings/SystemSculptSettingTab.ts");
  const addNode = read("src/views/studio/StudioNodeContextMenuOverlay.ts");

  assert.match(combobox, /export class SurfaceCombobox<T>/);
  assert.match(combobox, /aria-activedescendant/);
  assert.match(combobox, /"ArrowDown"/);
  assert.match(combobox, /"Home"/);
  assert.match(combobox, /scrollActiveOptionIntoView/);
  assert.match(history, /new SurfaceCombobox<SystemSculptHistoryEntry>/);
  assert.match(studio, /new SurfaceCombobox<StudioNodeConfigSelectOption>/);
  assert.match(vaultSearch, /new SurfaceCombobox<SearchHit>/);
  assert.match(settings, /new SurfaceCombobox<SettingsSearchMatch>/);
  assert.match(addNode, /new SurfaceCombobox<StudioNodeContextMenuItem>/);
  assert.doesNotMatch(history, /selectNext|selectPrevious|syncSelection/);
  assert.doesNotMatch(studio, /syncActiveDescendant|filteredOptions|activeIndex/);
  assert.doesNotMatch(vaultSearch, /activeResultEl|handleResultKeydown|setComboboxExpanded/);
  assert.doesNotMatch(settings, /selectedIndex|moveSearchSelection|syncRenderedSearchSelection/);
  assert.doesNotMatch(addNode, /filteredItems|activeIndex|moveActiveItem|refreshActiveStyles/);
  for (const source of [history, studio, vaultSearch, settings, addNode]) {
    assert.doesNotMatch(source, /setAttribute\(["']aria-activedescendant["']/);
  }
});

test("radio interaction and DOM realm ownership stay behind shared surface seams", () => {
  const radioGroup = read("src/core/ui/surface/SurfaceRadioGroup.ts");
  const chatSettings = read("src/modals/StandardChatSettingsModal.ts");
  const studioGroups = read("src/views/studio/StudioGraphGroupController.ts");
  const domContext = read("src/core/ui/surface/SurfaceDomContext.ts");
  const studioDomContext = read("src/views/studio/StudioDomContext.ts");
  const hoverShell = read("src/components/HoverShell.ts");
  const progress = read("src/core/ui/progress/OperationProgressPanel.ts");
  const statusBar = read("src/components/EmbeddingsStatusBar.ts");

  assert.match(radioGroup, /export function createUiRadioGroup/);
  assert.match(radioGroup, /group\.setAttribute\("role", "radiogroup"\)/);
  assert.match(radioGroup, /binding\.button\.setAttribute\("role", "radio"\)/);
  assert.match(chatSettings, /createUiRadioGroup\(choices, bindings/);
  assert.match(studioGroups, /createUiRadioGroup\(paletteEl, bindings/);
  for (const source of [chatSettings, studioGroups]) {
    assert.doesNotMatch(source, /setAttribute\(["']role["'],\s*["']radio(?:group)?["']\)/);
  }

  assert.match(domContext, /export function getSurfaceOwnerWindow/);
  assert.match(domContext, /export function resolveSurfaceDomContext/);
  assert.match(studioDomContext, /return getSurfaceOwnerWindow\(host\)/);
  assert.match(studioDomContext, /return requestSurfaceAnimationFrame\(host, callback\)/);
  assert.match(hoverShell, /resolveSurfaceDomContext\(options\.host\)/);
  assert.match(progress, /resolveSurfaceDomContext\(options\.host\)/);
  assert.match(statusBar, /subscribeLifecycle\(/);
  assert.doesNotMatch(statusBar, /setInterval|EmbeddingsStatusModal/);
});

test("obsolete browser-event and stream compatibility bridges stay deleted", () => {
  const production = listProductionTypeScript(path.join(root, "src"))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");

  assert.doesNotMatch(
    production,
    /systemsculpt:(?:context-changed|processing-changed)/,
  );
  assert.doesNotMatch(
    production,
    /translateManagedChatEvents|ManagedChatTranslationFence|streaming\/types/,
  );
  assert.equal(fs.existsSync(path.join(root, "src/streaming/types.ts")), false);
});

test("Studio clipboard and drop orchestration stays behind one typed controller", () => {
  const view = read("src/views/studio/SystemSculptStudioView.ts");
  const controller = read(
    "src/views/studio/systemsculpt-studio-view/StudioClipboardAndDropController.ts",
  );
  const baselineViewLines = 4_878;
  const currentViewLines = view.split(/\r?\n/).length;

  assert.match(view, /new StudioClipboardAndDropController\(this\.app/);
  assert.match(view, /this\.clipboardAndDropController\.bindOwnerWindow\(ownerWindow\)/);
  assert.match(view, /this\.clipboardAndDropController\.bindViewport\(this\.graphViewportEl\)/);
  assert.match(controller, /export interface StudioClipboardAndDropHost/);
  assert.match(controller, /private graphClipboardPayload:/);
  assert.match(controller, /async handlePaste\(event: ClipboardEvent\)/);
  assert.match(controller, /async handleDrop\(event: DragEvent\)/);
  assert.match(controller, /private isScopeCurrent\(scope: ProjectOperationScope\)/);
  assert.doesNotMatch(controller, /SystemSculptStudioView/);

  assert.doesNotMatch(
    view,
    /StudioGraphClipboardPasteMaterializer|StudioClipboardData|StudioClipboardPasteNodes|StudioVaultReferenceResolver/,
  );
  assert.doesNotMatch(
    view,
    /graphClipboardPayload|graphClipboardPasteCount|handleWindowPaste|pasteClipboardMedia|pasteClipboardText|collectDroppedVaultItems|dropMediaIntoStudio/,
  );
  assert.ok(
    baselineViewLines - currentViewLines >= 500,
    `Studio view extraction regressed: expected at least 500 lines removed from ${baselineViewLines}, got ${baselineViewLines - currentViewLines}`,
  );
});

test("Studio project and live-sync ownership stays behind one typed controller", () => {
  const view = read("src/views/studio/SystemSculptStudioView.ts");
  const controller = read(
    "src/views/studio/systemsculpt-studio-view/StudioProjectSessionController.ts",
  );
  const baselineViewLines = 4_878;
  const currentViewLines = view.split(/\r?\n/).length;

  const graphInteractionConstruction = view.indexOf("new StudioGraphInteractionEngine(");
  const sessionControllerConstruction = view.indexOf("new StudioProjectSessionController(");
  assert.ok(graphInteractionConstruction >= 0, "Studio must construct its graph interaction engine");
  assert.ok(
    sessionControllerConstruction > graphInteractionConstruction,
    "Studio must construct graph interaction before passing it to the session controller",
  );

  assert.match(controller, /export class StudioProjectSessionController/);
  assert.match(controller, /private currentProject: StudioProjectV1 \| null/);
  assert.match(controller, /private retainedProjectPath: string \| null/);
  assert.match(controller, /async loadProjectFromPath\(/);
  assert.match(controller, /async handleVaultItemModified\(/);
  assert.match(controller, /async handleVaultItemRenamed\(/);
  assert.match(controller, /async handleVaultItemDeleted\(/);
  assert.match(controller, /async flushPendingProjectSaveWork\(/);
  assert.match(controller, /private async releaseRetainedProjectSession\(/);
  assert.doesNotMatch(controller, /SystemSculptStudioView/);

  assert.match(view, /private readonly projectSessionController: StudioProjectSessionController/);
  assert.match(view, /return this\.projectSessionController\.getProject\(\)/);
  assert.match(view, /this\.projectSessionController\.handleVaultItemModified\(file\)/);
  assert.match(view, /this\.projectSessionController\.handleVaultItemRenamed\(file, oldPath\)/);
  assert.match(view, /this\.projectSessionController\.handleVaultItemDeleted\(file\)/);
  assert.doesNotMatch(view, /retainProjectSession|releaseProjectSession/);
  assert.doesNotMatch(view, /private (?:retainedProjectPath|pendingViewportState|graphViewStateByProjectPath|nodeDetailModeByProjectPath)\b/);
  assert.doesNotMatch(view, /projectSessionController\?:|self\.currentProject\s*=/);
  assert.ok(
    baselineViewLines - currentViewLines >= 1_100,
    `Studio session extraction regressed: expected at least 1,100 lines removed from ${baselineViewLines}, got ${baselineViewLines - currentViewLines}`,
  );
});

test("Studio image editing stays split into bounded feature-owned modules", () => {
  const coordinatorPath = "src/views/studio/graph-v3/StudioGraphImageEditorModal.ts";
  const moduleRoot = path.join(
    root,
    "src",
    "views",
    "studio",
    "graph-v3",
    "studio-image-editor",
  );
  const expectedModules = [
    "StudioImageEditorAssets.ts",
    "StudioImageEditorCanvas.ts",
    "StudioImageEditorInspector.ts",
    "StudioImageEditorModel.ts",
    "StudioImageEditorToolbar.ts",
    "StudioImageEditorTypes.ts",
  ];
  const actualModules = fs.readdirSync(moduleRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .sort();
  const coordinator = read(coordinatorPath);

  assert.deepEqual(actualModules, [...expectedModules].sort());
  assert.ok(
    coordinator.split(/\r?\n/).length <= 600,
    "the image editor modal must remain a lifecycle coordinator",
  );
  for (const module of expectedModules) {
    const lineCount = read(
      `src/views/studio/graph-v3/studio-image-editor/${module}`,
    ).split(/\r?\n/).length;
    assert.ok(lineCount <= 450, `${module} must stay below 450 lines`);
    assert.match(
      coordinator,
      new RegExp(`studio-image-editor/${module.replace(/\.ts$/, "")}`),
      `${coordinatorPath} must compose ${module}`,
    );
  }

  assert.doesNotMatch(
    coordinator,
    /private (?:handlePointerMove|renderLabelInspector|patchSelectedLabel|createNumberInput)|from "node:fs/,
  );
  const canvas = read(
    "src/views/studio/graph-v3/studio-image-editor/StudioImageEditorCanvas.ts",
  );
  const model = read(
    "src/views/studio/graph-v3/studio-image-editor/StudioImageEditorModel.ts",
  );
  assert.match(canvas, /ownerWindow\.addEventListener\("pointermove"/);
  assert.match(canvas, /captureHistory:\s*!interaction\.capturedHistory/);
  assert.match(model, /mutationOptions:\s*StudioGraphNodeMutationOptions/);
  assert.match(model, /commitSavedState/);
});

test("canonical action and modal CSS stay deep after feature migrations", () => {
  const manifest = read("src/css/index.css");
  const actionCss = read("src/css/primitives/surface-primitives.css");
  const feedbackCss = read("src/css/primitives/feedback.css");
  const modalCss = read("src/css/modals/modal.css");
  const agentCss = readCssDirectory("src/css/views/agent-workspace");
  const similarNotesCss = read("src/css/views/similar-notes.css");
  const studioCss = readCssDirectory("src/css/views/studio");

  const finalImport = manifest.lastIndexOf("@import");
  const focusInvariant = manifest.indexOf(".ss-surface .ss-button:focus-visible");
  assert.ok(focusInvariant > finalImport, "the action focus invariant must follow every feature sheet");
  assert.match(manifest.slice(focusInvariant), /box-shadow:\s*var\(--ss-ring\)/);
  assert.match(actionCss, /\.ss-surface \.ss-button--icon:not\([^}]+background:\s*transparent/s);

  assert.doesNotMatch(similarNotesCss, /\.ss-embeddings-view__icon-button:(?:hover|focus-visible)/);
  assert.doesNotMatch(agentCss, /\.systemsculpt-agent-(?:send|stop|icon-button)\s*\{/);
  assert.doesNotMatch(feedbackCss, /systemsculpt-(?:loading|license-banner|streaming-footnote)/);
  assert.doesNotMatch(studioCss, /ss-studio-node-http-bindings/);
  assert.equal(fs.existsSync(path.join(root, "src/css/views/preview.css")), false);

  assert.match(modalCss, /@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\.ss-modal[\s\S]*?width:\s*95vw/);
  assert.match(modalCss, /@container\s+ss-surface\s*\(max-width:\s*480px\)[\s\S]*?\.ss-modal__footer/);
  assert.match(modalCss, /@container\s+ss-surface\s*\(max-width:\s*360px\)[\s\S]*?flex-direction:\s*column/);
  assert.match(
    modalCss,
    /\.ss-modal__item\s*\{[^}]*width:\s*100%;[^}]*background-color:\s*transparent;[^}]*box-shadow:\s*none;[^}]*text-align:\s*left;/s,
  );
  assert.match(modalCss, /\.ss-modal__item:focus-visible\s*\{[^}]*box-shadow:\s*var\(--ss-ring\)/s);
  assert.equal(fs.existsSync(path.join(root, "src/css/components/system-feedback.css")), false);
  assert.doesNotMatch(modalCss, /var\(--text-error\)/);
  assert.match(modalCss, /\.ss-prompt-modal__field\[aria-invalid="true"\][^{]*\{[^}]*border-color:\s*var\(--ss-danger\)/s);
});

test("custom buttons outrank Obsidian controls without styling native Setting buttons", () => {
  const buttonCss = read("src/css/primitives/buttons.css");
  const actionCss = read("src/css/primitives/surface-primitives.css");
  const settingsCss = read("src/css/views/settings.css");

  assert.match(buttonCss, /^\.ss-surface \.ss-button\s*\{/m);
  assert.match(actionCss, /^\.ss-surface \.ss-button--icon\s*\{/m);
  assert.match(settingsCss, /^\.ss-surface \.ss-tab-button\s*\{/m);

  for (const source of [buttonCss, actionCss]) {
    assert.doesNotMatch(
      source,
      /(?:^|,\s*\n)\.ss-button(?:--|__|\b)/m,
      "canonical button selectors must be qualified by .ss-surface",
    );
  }
  assert.doesNotMatch(
    settingsCss,
    /(?:^|,\s*\n)\.ss-tab-button\b/m,
    "settings tab selectors must be qualified by .ss-surface",
  );
  assert.doesNotMatch(
    `${buttonCss}\n${settingsCss}`,
    /(?:^|,\s*\n)\s*(?:button|\.setting-item[^,{]*\s+button)\b/m,
    "SystemSculpt control styles must not select native Obsidian buttons",
  );
});

test("operation progress styles stay co-located and adapt inside the named surface container", () => {
  const progressCss = read("src/css/modals/progress-toast.css");
  const miscellaneousCss = read("src/css/modals/misc-modals.css");

  assert.match(
    progressCss,
    /\.systemsculpt-progress-panel\s*\{[^}]*width:\s*min\(350px,\s*calc\(100vw\s*-\s*var\(--ss-space-10\)\)\)/s,
  );
  assert.match(progressCss, /\.systemsculpt-progress-status\s*\{/);
  assert.match(progressCss, /\.systemsculpt-progress-status-icon\s*\{/);
  assert.match(progressCss, /\.systemsculpt-progress-status-text\s*\{/);
  assert.doesNotMatch(miscellaneousCss, /\.systemsculpt-progress-status(?:-|\s*\{)/);
  assert.match(
    progressCss,
    /@container\s+ss-surface\s*\(max-width:\s*320px\)[\s\S]*?\.systemsculpt-progress-buttons\s*\{[^}]*flex-wrap:\s*wrap[^}]*\}[\s\S]*?\.systemsculpt-progress-button\.ss-button\s*\{[^}]*flex:\s*1\s+1\s+100%[^}]*width:\s*100%/s,
  );
});
