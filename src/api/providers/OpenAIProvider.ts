import { requestUrl } from "obsidian";
import { BaseAIProvider } from "./BaseAIProvider";
import { Model, AIProvider } from "../Model";

export class OpenAIProvider extends BaseAIProvider {
  private readonly filteredWords = [
    "dall-e",
    "tts",
    "whisper",
    "embedding",
    "davinci",
    "babbage",
    "gpt-4-turbo-2024-04-09",
    "gpt-4-1106-preview",
    "gpt-4o-mini-2024-07-18",
    "gpt-4-turbo-preview",
    "gpt-4-0125-preview",
    "gpt-4o-2024-05-13",
    "gpt-3.5-turbo-instruct",
    "gpt-3.5-turbo-instruct-0914",
    "gpt-3.5-turbo-16k",
    "gpt-3.5-turbo-0125",
    "gpt-3.5-turbo-1106",
    "gpt-4-0613",
    "gpt-3.5-turbo",
    "gpt-4o-2024-08-06",
    "gpt-4o-realtime-preview",
    "o1-mini-2024-09-12",
    "o1-preview-2024-09-12",
    "gpt-4o-audio-preview",
  ];

  private readonly priorityOrder = [
    "gpt-4o",
    "gpt-4o-mini",
    "chatgpt-4o-latest",
    "o1-preview",
    "o1-mini",
    "gpt-4-turbo",
    "gpt-4",
  ];

  private readonly priorityContextLengths: { [key: string]: number } = {
    "gpt-4o": 128000,
    "gpt-4o-mini": 128000,
    "chatgpt-4o-latest": 128000,
    "o1-preview": 128000,
    "o1-mini": 128000,
    "gpt-4-turbo": 128000,
    "gpt-4": 8192,
  };

  private readonly priorityMaxOutputTokens: { [key: string]: number } = {
    "gpt-4o": 16384,
    "gpt-4o-mini": 16384,
    "chatgpt-4o-latest": 16384,
    "o1-preview": 32768,
    "o1-mini": 65536,
    "gpt-4-turbo": 4096,
    "gpt-4": 8192,
  };

  private readonly specialPricing: {
    [key: string]: { prompt: number; completion: number };
  } = {
    "gpt-4o": { prompt: 0.000005, completion: 0.000015 },
    "gpt-4o-mini": { prompt: 0.00000015, completion: 0.0000006 },
    "chatgpt-4o-latest": { prompt: 0.000005, completion: 0.000015 },
    "o1-preview": { prompt: 0.000015, completion: 0.00006 },
    "o1-mini": { prompt: 0.000003, completion: 0.000012 },
    "gpt-4-turbo": { prompt: 0.00001, completion: 0.00003 },
    "gpt-4": { prompt: 0.00003, completion: 0.00006 },
  };

  constructor(
    apiKey: string,
    _endpoint: string,
    settings: { temperature: number }
  ) {
    super(apiKey, "https://api.openai.com/v1", "openai", settings);
  }

  private isNonStreamingModel(modelId: string): boolean {
    return modelId === "o1-preview" || modelId === "o1-mini";
  }

  private shouldOmitMaxTokens(modelId: string): boolean {
    return modelId === "o1-preview" || modelId === "o1-mini";
  }

  private shouldConvertSystemToUser(modelId: string): boolean {
    return modelId === "o1-preview" || modelId === "o1-mini";
  }

  private shouldUseHardcodedTemperature(modelId: string): boolean {
    return modelId === "o1-preview" || modelId === "o1-mini";
  }

  async createChatCompletion(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number
  ): Promise<string> {
    const messages = this.shouldConvertSystemToUser(modelId)
      ? [
          { role: "user", content: systemPrompt },
          { role: "user", content: userMessage },
        ]
      : [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ];

    const requestData: any = {
      model: modelId,
      messages,
      temperature: this.shouldUseHardcodedTemperature(modelId)
        ? 1
        : this.settings.temperature,
    };

    if (!this.shouldOmitMaxTokens(modelId)) {
      requestData.max_tokens = maxOutputTokens;
    }

    const response = await fetch(`${this.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(requestData),
    });

    if (!response.ok) {
      throw new Error(`API request failed with status ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0].message.content.trim();
  }

  async createStreamingChatCompletionWithCallback(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const messages = this.shouldConvertSystemToUser(modelId)
      ? [
          { role: "user", content: systemPrompt },
          { role: "user", content: userMessage },
        ]
      : [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ];

    const requestData: any = {
      model: modelId,
      messages,
      stream: !this.isNonStreamingModel(modelId),
      temperature: this.shouldUseHardcodedTemperature(modelId)
        ? 1
        : this.settings.temperature,
    };

    if (!this.shouldOmitMaxTokens(modelId)) {
      requestData.max_tokens = maxOutputTokens;
    }

    const req = await fetch(`${this.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(requestData),
    });

    if (!req.ok || !req.body) {
      throw new Error(`API request failed with status ${req.status}`);
    }

    if (this.isNonStreamingModel(modelId)) {
      const data = await req.json();
      callback(JSON.stringify(data));
      return;
    }

    const reader = req.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let lastContent = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const decodedChunk = decoder.decode(value);
      buffer += decodedChunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.choices && data.choices[0].delta.content) {
              const newContent = data.choices[0].delta.content;
              if (newContent !== lastContent) {
                callback(line);
                lastContent = newContent;
              }
            } else {
              callback(line);
            }
          } catch (error) {
            callback(line);
          }
        }
      }
    }
  }

  async createStreamingConversationWithCallback(
    systemPrompt: string,
    messages: { role: string; content: string }[],
    modelId: string,
    maxOutputTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const formattedMessages = [
      { role: "system", content: systemPrompt },
      ...messages,
    ];

    const requestData: any = {
      model: modelId,
      messages: formattedMessages,
      stream: !this.isNonStreamingModel(modelId),
      temperature: this.shouldUseHardcodedTemperature(modelId)
        ? 1
        : this.settings.temperature,
    };

    if (!this.shouldOmitMaxTokens(modelId)) {
      requestData.max_tokens = maxOutputTokens;
    }

    const req = await fetch(`${this.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(requestData),
    });

    if (!req.ok || !req.body) {
      throw new Error(`API request failed with status ${req.status}`);
    }

    const reader = req.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let lastContent = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const decodedChunk = decoder.decode(value);
      buffer += decodedChunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.choices && data.choices[0].delta.content) {
              const newContent = data.choices[0].delta.content;
              if (newContent !== lastContent) {
                callback(line);
                lastContent = newContent;
              }
            } else {
              callback(line);
            }
          } catch (error) {
            callback(line);
          }
        }
      }
    }
  }

  protected async getModelsImpl(): Promise<Model[]> {
    if (!this.hasValidApiKey() || !this.endpoint?.trim()) {
      return [];
    }

    try {
      const response = await requestUrl({
        url: `${this.endpoint}/models`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (response.status !== 200) return [];

      const data = response.json;
      const filteredModels = data.data.filter(
        (model: any) =>
          !this.filteredWords.some((word) =>
            model.id.toLowerCase().includes(word)
          )
      );

      const sortedModels = filteredModels.sort((a: any, b: any) => {
        const aIndex = this.priorityOrder.findIndex(
          (prefix) => a.id === prefix
        );
        const bIndex = this.priorityOrder.findIndex(
          (prefix) => b.id === prefix
        );
        if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
        if (aIndex !== -1) return -1;
        if (bIndex !== -1) return 1;
        return a.id.localeCompare(b.id);
      });

      return sortedModels.map((model: any) => ({
        id: model.id,
        name: model.id,
        provider: "openai" as AIProvider,
        contextLength:
          this.priorityContextLengths[model.id] ||
          model.context_window ||
          undefined,
        maxOutputTokens:
          this.priorityMaxOutputTokens[model.id] ||
          model.context_window ||
          4096,
        pricing:
          this.specialPricing[model.id] ||
          (model.pricing
            ? {
                prompt: parseFloat(model.pricing.prompt),
                completion: parseFloat(model.pricing.completion),
              }
            : { prompt: 0, completion: 0 }),
      }));
    } catch (error) {
      console.error("Failed to fetch OpenAI models:", error);
      return [];
    }
  }

  static async validateApiKey(
    apiKey: string,
    endpoint: string
  ): Promise<boolean> {
    if (!apiKey) return false;

    try {
      const response = await requestUrl({
        url: `${endpoint}/models`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      return response.status === 200;
    } catch (error) {
      console.error("Failed to validate OpenAI API key:", error);
      return false;
    }
  }
}
