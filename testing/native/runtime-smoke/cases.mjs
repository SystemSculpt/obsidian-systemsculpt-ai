import { CORE_CASES, EXTENDED_CASES } from "./constants.mjs";

function resolveAudioPath(fixtureDir, explicitPath) {
  return explicitPath || `${fixtureDir}/audio-phrases.m4a`;
}

function chatSetupSnippet(promptLiteral) {
  return `
    const plugin = app?.plugins?.getPlugin?.('systemsculpt-ai') || app?.plugins?.plugins?.['systemsculpt-ai'];
    if (!plugin) throw new Error('SystemSculpt plugin missing');
    const selectedModelId = plugin?.settings?.selectedModelId || 'systemsculpt@@systemsculpt/ai-agent';
    const existingLeaves = app.workspace.getLeavesOfType('systemsculpt-chat-view') || [];
    const isMobile = !!app?.isMobile;
    let leaf = isMobile ? (existingLeaves[existingLeaves.length - 1] || null) : null;
    for (const existing of existingLeaves) {
      if (existing?.view) existing.view.__systemsculptSmokeActive = false;
      if (existing === leaf) {
        continue;
      }
      if (typeof existing.detach === 'function') {
        try {
          existing.detach();
        } catch {}
      }
    }
    if (!leaf) {
      try {
        leaf = app.workspace.getLeaf('tab');
      } catch (error) {
        if (!/tab group/i.test(String(error?.message || error || ''))) {
          throw error;
        }
      }
      leaf = leaf || app.workspace.getLeaf(true);
    }
    await leaf.setViewState({ type: 'systemsculpt-chat-view', state: { chatId: '', selectedModelId } });
    app.workspace.setActiveLeaf(leaf, { focus: true });
    if (leaf?.view) {
      leaf.view.__systemsculptSmokeManaged = true;
      leaf.view.__systemsculptSmokeActive = true;
    }
    const view = leaf?.view;
    const handler = view?.inputHandler;
    const input = handler?.input || handler?.inputElement || handler?.textarea;
    if (!view || !handler || !input) throw new Error('Chat runtime unavailable');
    input.value = ${promptLiteral};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const readyFn = handler.isChatReady ?? handler['isChatReady'];
    const isReady = () => typeof readyFn === 'function' ? !!readyFn.call(handler) : true;
    const readyDeadline = Date.now() + 30000;
    while (!isReady() && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!isReady()) throw new Error('Chat did not become ready');
    const sendFn = handler.handleSendMessage ?? handler['handleSendMessage'];
    if (typeof sendFn !== 'function') throw new Error('Chat send handler missing');
    const initialMessageCount = Array.isArray(view.messages) ? view.messages.length : 0;
    let turnSettled = false;
    let turnError = null;
    const sendPromise = Promise.resolve(sendFn.call(handler)).then(
      () => {
        turnSettled = true;
      },
      (error) => {
        turnSettled = true;
        turnError = error;
      }
    );
  `;
}

function chatCompletionLoopSnippet() {
  return `
    const clickApprove = () => {
      const directButtons = Array.from(document.querySelectorAll('.systemsculpt-popup [data-button-text="Approve"]'));
      const directButton = directButtons[directButtons.length - 1] || null;
      if (directButton) {
        directButton.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        directButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        directButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        directButton.click();
        return true;
      }
      const fallbackButtons = Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter((element) => /approve/i.test((element.textContent || '').trim()));
      const fallbackButton = fallbackButtons[fallbackButtons.length - 1] || null;
      if (!fallbackButton) return false;
      fallbackButton.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      fallbackButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      fallbackButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      fallbackButton.click();
      return true;
    };
    const toText = (content) => {
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.map((part) => typeof part === 'string' ? part : (part?.text || part?.content || part?.value || '')).join('');
      }
      if (content && typeof content === 'object') {
        return content.text || content.content || JSON.stringify(content);
      }
      return String(content ?? '');
    };
    const terminalStates = new Set(['completed', 'failed', 'denied']);
    const seenToolCalls = [];
    const seenToolCallIds = new Set();
    let sawChatActivity = false;
    let approvalClicks = 0;
    let timeoutState = null;
    let stableSince = 0;
    let sendSettledAfterStable = false;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const messages = Array.isArray(view.messages) ? view.messages : [];
      const toolCalls = messages.flatMap((message) => Array.isArray(message?.tool_calls) ? message.tool_calls : []);
      for (const call of toolCalls) {
        if (!call?.id || seenToolCallIds.has(call.id)) continue;
        seenToolCallIds.add(call.id);
        seenToolCalls.push({
          id: call.id,
          name: call.request?.function?.name ?? '',
          state: call.state ?? '',
        });
      }
      if (clickApprove()) {
        approvalClicks += 1;
      }
      const popupVisible = !!document.querySelector('.systemsculpt-popup, .ss-approval-card, .ss-approval-deck');
      const messageCount = messages.length;
      const activeToolCalls = toolCalls.filter((entry) => !terminalStates.has(entry?.state)).length;
      sawChatActivity = sawChatActivity || view.isGenerating || popupVisible || activeToolCalls > 0 || messageCount > initialMessageCount;
      const lastAssistant = [...messages].reverse().find((message) => message?.role === 'assistant') || null;
      const lastAssistantText = toText(lastAssistant?.content).trim();
      const stableNow =
        sawChatActivity &&
        !view.isGenerating &&
        activeToolCalls === 0 &&
        !popupVisible &&
        lastAssistantText.length > 0;
      if (stableNow) {
        stableSince = stableSince || Date.now();
      } else {
        stableSince = 0;
      }
      if (
        stableNow &&
        Date.now() - stableSince >= 1500
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (Date.now() >= deadline) {
      const messages = Array.isArray(view.messages) ? view.messages : [];
      const toolCalls = messages.flatMap((message) => Array.isArray(message?.tool_calls) ? message.tool_calls : []);
      timeoutState = {
        turnSettled,
        popupVisible: !!document.querySelector('.systemsculpt-popup, .ss-approval-card, .ss-approval-deck'),
        isGenerating: !!view.isGenerating,
        messageCount: messages.length,
        toolCalls: toolCalls.map((call) => ({
          id: call?.id ?? null,
          name: call?.request?.function?.name ?? '',
          state: call?.state ?? '',
        })),
      };
      throw new Error('Runtime smoke turn timed out: ' + JSON.stringify(timeoutState));
    }
    await Promise.race([
      sendPromise.then(() => {
        sendSettledAfterStable = true;
      }),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (turnError) {
      throw turnError;
    }
    const messages = Array.isArray(view.messages) ? view.messages.map((message) => ({
      role: message.role,
      content: message.content,
      tool_calls: message.tool_calls,
    })) : [];
    const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  `;
}

function buildChatExactExpression(token) {
  return `(async () => {
    ${chatSetupSnippet(JSON.stringify(`Reply with exactly ${token}`))}
    ${chatCompletionLoopSnippet()}
    return {
      token: ${JSON.stringify(token)},
      selectedModelId,
      lastAssistant: toText(lastAssistant?.content).trim(),
      messageCount: messages.length,
      seenToolCalls,
      approvalClicks,
      sendSettledAfterStable,
    };
  })()`;
}

function buildFileReadExpression(fixtureDir) {
  const prompt =
    `Use your filesystem tools to read ${fixtureDir}/alpha.md and ${fixtureDir}/beta.md. ` +
    "Then reply with exactly: ALPHA=ALPHA_20260311-194643; BETA=BETA_20260311-194643; SHARED=GAMMA_20260311-194643";
  return `(async () => {
    ${chatSetupSnippet(JSON.stringify(prompt))}
    ${chatCompletionLoopSnippet()}
    return {
      lastAssistant: toText(lastAssistant?.content).trim(),
      messageCount: messages.length,
      seenToolCalls,
      approvalClicks,
      sendSettledAfterStable,
    };
  })()`;
}

function buildFileWriteExpression(fixtureDir, outputFileName) {
  const outputPath = `${fixtureDir}/${outputFileName}`;
  const prompt =
    `Use your filesystem tools to read ${fixtureDir}/alpha.md and ${fixtureDir}/beta.md, ` +
    `write a file at ${outputPath} containing the three lines ` +
    "ALPHA=ALPHA_20260311-194643, BETA=BETA_20260311-194643, SHARED=GAMMA_20260311-194643, " +
    "then read that file back and reply with exactly: Confirmed: ALPHA=ALPHA_20260311-194643 BETA=BETA_20260311-194643 SHARED=GAMMA_20260311-194643";
  return `(async () => {
    ${chatSetupSnippet(JSON.stringify(prompt))}
    ${chatCompletionLoopSnippet()}
    const outputPath = ${JSON.stringify(outputPath)};
    const outputFile = app.vault.getAbstractFileByPath(outputPath);
    const outputContents = outputFile ? await app.vault.read(outputFile) : null;
    return {
      outputPath,
      outputExists: !!outputFile,
      outputContents,
      lastAssistant: toText(lastAssistant?.content).trim(),
      messageCount: messages.length,
      seenToolCalls,
      approvalClicks,
      sendSettledAfterStable,
    };
  })()`;
}

function buildEmbeddingsExpression(fixtureDir) {
  return `(async () => {
    const plugin = app?.plugins?.plugins?.['systemsculpt-ai'];
    if (!plugin) throw new Error('SystemSculpt plugin missing');
    const manager = await plugin.getOrCreateEmbeddingsManager();
    await manager.initialize?.();
    const waitForIdle = async (timeoutMs = 90000) => {
      const startedAt = Date.now();
      const deadline = startedAt + timeoutMs;
      while (Date.now() < deadline) {
        const timerCount = manager?.perPathTimers?.size ?? 0;
        const inFlightCount = manager?.inFlightPaths?.size ?? 0;
        const scheduledAt = manager?.scheduledVaultRunAt ?? null;
        const processing =
          typeof manager?.isCurrentlyProcessing === 'function'
            ? !!manager.isCurrentlyProcessing()
            : !!manager?.processingMutex?.isLocked?.();
        const scheduled =
          typeof scheduledAt === 'number' &&
          Number.isFinite(scheduledAt) &&
          scheduledAt > Date.now();
        if (!processing && timerCount === 0 && inFlightCount === 0 && !scheduled) {
          return {
            waitedForIdleMs: Date.now() - startedAt,
            timerCount,
            inFlightCount,
            processing,
            scheduled,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error('Embeddings manager did not become idle before smoke assertion.');
    };
    const idle = await waitForIdle();
    const alphaPath = ${JSON.stringify(`${fixtureDir}/alpha.md`)};
    const betaPath = ${JSON.stringify(`${fixtureDir}/beta.md`)};
    const alpha = app.vault.getAbstractFileByPath(alphaPath);
    const beta = app.vault.getAbstractFileByPath(betaPath);
    if (!alpha || !beta) throw new Error('Embedding fixture missing');
    await manager.processFileIfNeeded?.(alpha, 'manual');
    await manager.processFileIfNeeded?.(beta, 'manual');
    const similar = await manager.findSimilar(alphaPath, 5);
    return {
      ...idle,
      count: Array.isArray(similar) ? similar.length : null,
      top: Array.isArray(similar) ? similar.slice(0, 5).map((item) => ({ path: item.path, score: item.score })) : similar,
    };
  })()`;
}

function buildTranscribeExpression(audioPath) {
  return `(async () => {
    const plugin = app?.plugins?.plugins?.['systemsculpt-ai'];
    if (!plugin) throw new Error('SystemSculpt plugin missing');
    const service = plugin.getTranscriptionService?.();
    if (!service) throw new Error('Transcription service unavailable');
    const filePath = ${JSON.stringify(audioPath)};
    const file = app.vault.getAbstractFileByPath(filePath);
    if (!file) throw new Error('Audio fixture missing');
    const progress = [];
    const raw = await service.transcribeFile(file, {
      onProgress: (stage, message, details) => {
        progress.push({ stage, message, details });
      }
    });
    const text = typeof raw === 'string' ? raw : raw?.text ?? null;
    return {
      text,
      resultType: typeof raw,
      progress,
    };
  })()`;
}

function buildRecordTranscribeExpression(fixtureDir, audioPath) {
  const recordingsDir = `${fixtureDir}/runtime-recordings`;
  return `(async () => {
    const plugin = app?.plugins?.plugins?.['systemsculpt-ai'];
    if (!plugin) throw new Error('SystemSculpt plugin missing');
    const recorderService = plugin.getRecorderService?.();
    if (!recorderService) throw new Error('Recorder service unavailable');
    const audioFilePath = ${JSON.stringify(audioPath)};
    const audioFile = app.vault.getAbstractFileByPath(audioFilePath);
    if (!audioFile) throw new Error('Recorder fixture audio missing');
    const recordingsDir = ${JSON.stringify(recordingsDir)};
    const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextCtor) throw new Error('AudioContext is unavailable in this runtime');
    if (!navigator?.mediaDevices?.getUserMedia) throw new Error('navigator.mediaDevices.getUserMedia is unavailable');

    const waitFor = async (predicate, timeoutMs, message) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await predicate()) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(message);
    };

    const ensureFolder = async (folderPath) => {
      const parts = String(folderPath || '').split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current = current ? \`\${current}/\${part}\` : part;
        if (app.vault.getAbstractFileByPath(current)) continue;
        try {
          await app.vault.createFolder(current);
        } catch (error) {
          const message = String(error?.message || error || '');
          if (!/exist/i.test(message)) throw error;
        }
      }
    };

    const deleteFolderFiles = async (folderPath) => {
      const files = app.vault.getFiles().filter((file) => file.path.startsWith(\`\${folderPath}/\`));
      for (const file of files) {
        try {
          await app.vault.delete(file, true);
        } catch {}
      }
      return files.map((file) => file.path);
    };

    const listFolderFiles = () =>
      app.vault
        .getFiles()
        .filter((file) => file.path.startsWith(\`\${recordingsDir}/\`))
        .map((file) => ({
          path: file.path,
          extension: String(file.extension || '').toLowerCase(),
        }))
        .sort((a, b) => a.path.localeCompare(b.path));

    const mediaDevices = navigator.mediaDevices;
    const originalDescriptor = Object.getOwnPropertyDescriptor(mediaDevices, 'getUserMedia');
    const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
    const previousSettings = {
      autoTranscribeRecordings: plugin.settings.autoTranscribeRecordings,
      keepRecordingsAfterTranscription: plugin.settings.keepRecordingsAfterTranscription,
      autoPasteTranscription: plugin.settings.autoPasteTranscription,
      cleanTranscriptionOutput: plugin.settings.cleanTranscriptionOutput,
      postProcessingEnabled: plugin.settings.postProcessingEnabled,
      recordingsDirectory: plugin.settings.recordingsDirectory,
    };
    const previousOnTranscriptionDone = recorderService.onTranscriptionDone;
    const state = {
      callbackText: null,
      mic: null,
    };

    const installGetUserMedia = (replacement) => {
      try {
        Object.defineProperty(mediaDevices, 'getUserMedia', {
          configurable: true,
          writable: true,
          value: replacement,
        });
      } catch {
        mediaDevices.getUserMedia = replacement;
      }
    };

    const restoreGetUserMedia = () => {
      if (originalDescriptor) {
        Object.defineProperty(mediaDevices, 'getUserMedia', originalDescriptor);
      } else {
        mediaDevices.getUserMedia = originalGetUserMedia;
      }
    };

    const cleanupMic = async () => {
      const mic = state.mic;
      state.mic = null;
      if (!mic) return;
      try {
        mic.stream?.getTracks?.().forEach((track) => track.stop());
      } catch {}
      try {
        if (!mic.ended && mic.started) {
          mic.source?.stop?.(0);
        }
      } catch {}
      try {
        await mic.audioContext?.close?.();
      } catch {}
    };

    const decodeAudioBuffer = async (audioContext, arrayBuffer) => {
      return await new Promise((resolve, reject) => {
        const maybePromise = audioContext.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then(resolve, reject);
        }
      });
    };

    const createFixtureMic = async () => {
      const arrayBuffer = await app.vault.readBinary(audioFile);
      const audioContext = new AudioContextCtor();
      if (typeof audioContext.resume === 'function') {
        await audioContext.resume().catch(() => {});
      }
      const decoded = await decodeAudioBuffer(audioContext, arrayBuffer);
      const destination = audioContext.createMediaStreamDestination();
      const source = audioContext.createBufferSource();
      source.buffer = decoded;
      source.connect(destination);
      const mic = {
        audioContext,
        destination,
        source,
        stream: destination.stream,
        started: false,
        ended: false,
        endedPromise: null,
        start() {
          if (this.started) return;
          this.started = true;
          source.start(0);
        },
      };
      mic.endedPromise = new Promise((resolve) => {
        source.onended = () => {
          mic.ended = true;
          resolve();
        };
      });
      state.mic = mic;
      return mic;
    };

    await ensureFolder(recordingsDir);
    const removedPaths = await deleteFolderFiles(recordingsDir);
    Object.assign(plugin.settings, {
      autoTranscribeRecordings: true,
      keepRecordingsAfterTranscription: true,
      autoPasteTranscription: false,
      cleanTranscriptionOutput: true,
      postProcessingEnabled: false,
      recordingsDirectory: recordingsDir,
    });
    recorderService.onTranscriptionDone = (text) => {
      state.callbackText = String(text || '');
    };

    try {
      installGetUserMedia(async () => {
        const mic = await createFixtureMic();
        return mic.stream;
      });

      await recorderService.toggleRecording();
      await waitFor(
        () => recorderService.isRecording === true || recorderService.lifecycleState === 'recording',
        20000,
        'Recorder did not enter the recording state'
      );

      const mic = state.mic;
      if (!mic || typeof mic.start !== 'function') {
        throw new Error('Fixture microphone was not created');
      }

      mic.start();
      await mic.endedPromise;
      await new Promise((resolve) => setTimeout(resolve, 750));

      await recorderService.toggleRecording();
      await waitFor(
        () => recorderService.isRecording === false && recorderService.lifecycleState === 'idle',
        30000,
        'Recorder did not return to idle after stopping'
      );

      await waitFor(
        () => typeof state.callbackText === 'string' && state.callbackText.trim().length > 0,
        180000,
        'Recorder transcription did not complete'
      );

      const folderFiles = listFolderFiles();
      const markdownEntry = folderFiles.find((entry) => entry.extension === 'md') || null;
      const markdownFile = markdownEntry ? app.vault.getAbstractFileByPath(markdownEntry.path) : null;
      const transcriptText =
        markdownFile && typeof app.vault.read === 'function' ? await app.vault.read(markdownFile) : null;

      return {
        sourceAudioPath: audioFilePath,
        recordingsDir,
        removedPaths,
        recordingPath: recorderService.lastRecordingPath || null,
        callbackText: state.callbackText,
        folderFiles,
        transcriptPath: markdownEntry?.path || null,
        transcriptText,
      };
    } finally {
      if (recorderService.isRecording) {
        await recorderService.toggleRecording().catch(() => {});
      }
      await cleanupMic();
      restoreGetUserMedia();
      recorderService.onTranscriptionDone = previousOnTranscriptionDone;
      Object.assign(plugin.settings, previousSettings);
    }
  })()`;
}

function buildWebFetchExpression(url) {
  return `(async () => {
    const plugin = app?.plugins?.plugins?.['systemsculpt-ai'];
    if (!plugin) throw new Error('SystemSculpt plugin missing');
    const api = plugin.getWebResearchApiService?.();
    const corpus = plugin.getWebResearchCorpusService?.();
    if (!api) throw new Error('Web research API service unavailable');
    if (!corpus) throw new Error('Web research corpus service unavailable');
    const response = await api.fetch({ url: ${JSON.stringify(url)}, maxChars: 5000 });
    const chatId = 'runtime-smoke-web-' + Date.now();
    const written = await corpus.writeFetchRun({ chatId, url: ${JSON.stringify(url)}, fetch: response });
    const indexFile = app.vault.getAbstractFileByPath(written.indexPath);
    const fetchedFile = app.vault.getAbstractFileByPath(written.filePath);
    return {
      requestedUrl: ${JSON.stringify(url)},
      responseUrl: response.url,
      finalUrl: response.finalUrl,
      title: response.title,
      contentType: response.contentType,
      markdownPreview: String(response.markdown || '').slice(0, 500),
      indexPath: written.indexPath,
      filePath: written.filePath,
      indexExists: !!indexFile,
      fetchedExists: !!fetchedFile,
      indexPreview: indexFile ? String(await app.vault.read(indexFile)).slice(0, 500) : null,
    };
  })()`;
}

function buildYouTubeTranscriptExpression(url) {
  return `(async () => {
    const plugin = app?.plugins?.plugins?.['systemsculpt-ai'];
    if (!plugin) throw new Error('SystemSculpt plugin missing');
    const service = plugin.getYouTubeTranscriptService?.();
    if (!service) throw new Error('YouTube transcript service unavailable');
    const result = await service.getTranscript(${JSON.stringify(url)});
    return {
      url: ${JSON.stringify(url)},
      lang: result?.lang ?? null,
      textLength: String(result?.text || '').length,
      excerpt: String(result?.text || '').slice(0, 500),
      metadata: result?.metadata ?? null,
    };
  })()`;
}

export async function runCase(runtime, options, caseName) {
  switch (caseName) {
    case "chat-exact":
      return await runtime.evaluate(buildChatExactExpression("RUNTIME_SMOKE_OK_20260311"));
    case "file-read":
      return await runtime.evaluate(buildFileReadExpression(options.fixtureDir));
    case "file-write":
      return await runtime.evaluate(
        buildFileWriteExpression(
          options.fixtureDir,
          options.mode === "android" ? "android-output-write.md" : "runtime-output-write.md"
        )
      );
    case "embeddings":
      return await runtime.evaluate(buildEmbeddingsExpression(options.fixtureDir));
    case "transcribe":
      return await runtime.evaluate(
        buildTranscribeExpression(resolveAudioPath(options.fixtureDir, options.transcribeAudioPath))
      );
    case "record-transcribe":
      return await runtime.evaluate(
        buildRecordTranscribeExpression(
          options.fixtureDir,
          resolveAudioPath(options.fixtureDir, options.recordAudioPath)
        ),
        480000
      );
    case "web-fetch":
      return await runtime.evaluate(buildWebFetchExpression(options.webFetchUrl));
    case "youtube-transcript":
      return await runtime.evaluate(buildYouTubeTranscriptExpression(options.youtubeUrl), 480000);
    default:
      throw new Error(`Unsupported case: ${caseName}`);
  }
}

export function caseList(caseName) {
  if (caseName === "all") {
    return CORE_CASES;
  }
  if (caseName === "extended") {
    return EXTENDED_CASES;
  }
  return [caseName];
}

export function assertCaseResult(caseName, options, result) {
  if (!result || typeof result !== "object") {
    throw new Error(`${caseName} returned no result payload.`);
  }

  if (caseName === "chat-exact") {
    const expected = "RUNTIME_SMOKE_OK_20260311";
    if (result.lastAssistant !== expected) {
      throw new Error(`${caseName} expected "${expected}" but got "${result.lastAssistant || ""}".`);
    }
    return;
  }

  if (caseName === "file-read") {
    const expected =
      "ALPHA=ALPHA_20260311-194643; BETA=BETA_20260311-194643; SHARED=GAMMA_20260311-194643";
    if (result.lastAssistant !== expected) {
      throw new Error(`${caseName} expected exact fixture echo but got "${result.lastAssistant || ""}".`);
    }
    return;
  }

  if (caseName === "file-write") {
    const expectedAssistant =
      "Confirmed: ALPHA=ALPHA_20260311-194643 BETA=BETA_20260311-194643 SHARED=GAMMA_20260311-194643";
    const expectedLines = [
      "ALPHA=ALPHA_20260311-194643",
      "BETA=BETA_20260311-194643",
      "SHARED=GAMMA_20260311-194643",
    ];
    if (result.lastAssistant !== expectedAssistant) {
      throw new Error(`${caseName} expected confirmed echo but got "${result.lastAssistant || ""}".`);
    }
    if (!result.outputExists) {
      throw new Error(`${caseName} did not create ${result.outputPath || "the output file"}.`);
    }
    const outputContents = String(result.outputContents || "");
    for (const line of expectedLines) {
      if (!outputContents.includes(line)) {
        throw new Error(`${caseName} output file is missing "${line}".`);
      }
    }
    return;
  }

  if (caseName === "embeddings") {
    const candidatePaths = Array.isArray(result?.top)
      ? result.top.map((item) => String(item?.path || ""))
      : [];
    const matched = candidatePaths.some(
      (path) => path.endsWith("/beta.md") || path.endsWith("beta.md")
    );
    if (!matched) {
      throw new Error(
        `${caseName} expected beta.md among the nearest results but got ${JSON.stringify(candidatePaths)}.`
      );
    }
    return;
  }

  if (caseName === "transcribe") {
    const text = String(result.text || "");
    const requiredPhrases = ["Crimson Harbor", "Silver Cactus", "Golden Lantern"];
    for (const phrase of requiredPhrases) {
      if (!text.includes(phrase)) {
        throw new Error(`${caseName} is missing transcription phrase "${phrase}".`);
      }
    }
    return;
  }

  if (caseName === "record-transcribe") {
    const transcript = String(result.callbackText || result.transcriptText || "");
    const requiredPhrases = ["Crimson Harbor", "Silver Cactus", "Golden Lantern"];
    for (const phrase of requiredPhrases) {
      if (!transcript.includes(phrase)) {
        throw new Error(`${caseName} is missing transcription phrase "${phrase}".`);
      }
    }
    if (!result.recordingPath) {
      throw new Error(`${caseName} did not report the saved recording path.`);
    }
    const folderFiles = Array.isArray(result.folderFiles) ? result.folderFiles : [];
    const audioEntries = folderFiles.filter((entry) =>
      ["wav", "m4a", "webm", "ogg", "mp3"].includes(String(entry?.extension || ""))
    );
    const markdownEntries = folderFiles.filter((entry) => String(entry?.extension || "") === "md");
    if (audioEntries.length === 0) {
      throw new Error(`${caseName} did not keep the recorded audio artifact.`);
    }
    if (markdownEntries.length === 0) {
      throw new Error(`${caseName} did not persist a transcript markdown file.`);
    }
    return;
  }

  if (caseName === "web-fetch") {
    const markdownPreview = String(result.markdownPreview || "");
    const normalizeHost = (value) => {
      if (!value) return "";
      try {
        return new URL(String(value)).host.replace(/^www\./, "").toLowerCase();
      } catch {
        return "";
      }
    };
    const expectedHost = normalizeHost(options.webFetchUrl);
    const actualUrl = String(result.finalUrl || result.responseUrl || result.requestedUrl || "");
    const actualHost = normalizeHost(actualUrl);
    if (!expectedHost || actualHost !== expectedHost) {
      throw new Error(`${caseName} expected host "${expectedHost}" but got "${actualHost}" from "${actualUrl}".`);
    }
    if (markdownPreview.trim().length < 80) {
      throw new Error(`${caseName} did not return enough fetched content.`);
    }
    if (!result.indexExists || !result.fetchedExists) {
      throw new Error(`${caseName} did not write the fetched corpus artifacts to the vault.`);
    }
    return;
  }

  if (caseName === "youtube-transcript") {
    const textLength = Number(result.textLength || 0);
    if (!Number.isFinite(textLength) || textLength < 1000) {
      throw new Error(`${caseName} expected a substantial transcript but got length ${result.textLength || 0}.`);
    }
  }
}
