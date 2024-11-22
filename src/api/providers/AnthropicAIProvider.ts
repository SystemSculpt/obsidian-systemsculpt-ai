import Anthropic from "@anthropic-ai/sdk";
import { BaseAIProvider } from "./BaseAIProvider";
import { Model } from "../Model";
import { Notice } from "obsidian";

export class AnthropicAIProvider extends BaseAIProvider {
  static async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      const anthropic = new Anthropic({
        apiKey,
        dangerouslyAllowBrowser: true,
      });
      await anthropic.messages.create({
        model: "claude-3-haiku-20240307",
        messages: [{ role: "user", content: "test" }],
        max_tokens: 1,
      });
      return true;
    } catch {
      return false;
    }
  }

  private client: Anthropic;

  constructor(
    apiKey: string,
    _endpoint: string,
    settings: { temperature: number }
  ) {
    super(apiKey, "https://api.anthropic.com", "anthropic", settings);
    this.client = new Anthropic({
      apiKey,
      dangerouslyAllowBrowser: true,
    });
  }

  private getMaxTokensForModel(modelId: string): number {
    if (modelId.includes("sonnet")) {
      return 8192;
    }
    return 4096; // default for haiku and opus
  }

  async createChatCompletion(
    systemPrompt: string,
    userMessage: string,
    modelId: string
  ): Promise<string> {
    const response = await this.client.messages.create({
      model: modelId,
      messages: [{ role: "user", content: userMessage }],
      system: systemPrompt,
      temperature: this.settings.temperature,
      max_tokens: this.getMaxTokensForModel(modelId),
    });

    return response.content[0].type === "text" ? response.content[0].text : "";
  }

  async createStreamingChatCompletionWithCallback(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const stream = await this.client.messages.create({
      model: modelId,
      messages: [{ role: "user", content: userMessage }],
      system: systemPrompt,
      temperature: this.settings.temperature,
      stream: true,
      max_tokens: this.getMaxTokensForModel(modelId),
    });

    for await (const chunk of stream) {
      if (abortSignal?.aborted) break;
      if (
        chunk.type === "content_block_delta" &&
        chunk.delta.type === "text_delta"
      ) {
        callback(chunk.delta.text);
      }
    }
  }

  async createStreamingConversationWithCallback(
    systemPrompt: string,
    messages: {
      role: string;
      content:
        | string
        | { type: string; text?: string; image_url?: { url: string } }[];
    }[],
    modelId: string,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    try {
      if (
        modelId.includes("haiku") &&
        messages.some(
          (msg) =>
            Array.isArray(msg.content) &&
            msg.content.some((c) => c.type === "image_url")
        )
      ) {
        new Notice(
          "Claude 3.5 Haiku does not support image analysis. Please use Claude 3.5 Sonnet or Claude 3 Opus for image-related tasks.",
          15000
        );
        return;
      }

      const formattedMessages: Anthropic.MessageParam[] = messages.map(
        (msg) => ({
          role: msg.role as "user" | "assistant",
          content: Array.isArray(msg.content)
            ? msg.content.map((c) => {
                if (c.type === "image_url" && c.image_url) {
                  const base64Data = c.image_url.url.replace(
                    /^data:image\/[a-zA-Z]+;base64,/,
                    ""
                  );
                  const mediaTypeMatch = c.image_url.url.match(
                    /^data:(image\/[a-zA-Z]+);base64,/
                  );
                  const mediaType = mediaTypeMatch
                    ? mediaTypeMatch[1]
                        .toLowerCase()
                        .replace("image/jpg", "image/jpeg")
                    : "image/jpeg";

                  return {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: mediaType as
                        | "image/jpeg"
                        | "image/png"
                        | "image/gif"
                        | "image/webp",
                      data: base64Data,
                    },
                  } as Anthropic.ImageBlockParam;
                }
                return {
                  type: "text",
                  text: c.text || "",
                } as Anthropic.TextBlockParam;
              })
            : msg.content,
        })
      );

      const stream = await this.client.messages.create({
        model: modelId,
        messages: formattedMessages,
        system: systemPrompt,
        temperature: this.settings.temperature,
        stream: true,
        max_tokens: this.getMaxTokensForModel(modelId),
      });

      for await (const chunk of stream) {
        if (abortSignal?.aborted) break;
        if (
          chunk.type === "content_block_delta" &&
          chunk.delta.type === "text_delta"
        ) {
          callback(chunk.delta.text);
        }
      }
    } catch (error) {
      console.error("Error creating streaming conversation:", error);
    }
  }

  async getModelsImpl(): Promise<Model[]> {
    return [
      {
        id: "claude-3-5-haiku-latest",
        name: "Claude 3.5 Haiku (Latest)",
        provider: "anthropic",
        contextLength: 200000,
        pricing: {
          prompt: 0.003,
          completion: 0.015,
        },
      },
      {
        id: "claude-3-5-sonnet-latest",
        name: "Claude 3.5 Sonnet (Latest)",
        provider: "anthropic",
        contextLength: 200000,
        pricing: {
          prompt: 0.003,
          completion: 0.015,
        },
      },
      {
        id: "claude-3-opus-latest",
        name: "Claude 3 Opus (Latest)",
        provider: "anthropic",
        contextLength: 200000,
        pricing: {
          prompt: 0.015,
          completion: 0.075,
        },
      },
    ];
  }
}
