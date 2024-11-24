import { requestUrl, RequestUrlParam, TFile, App } from "obsidian";
import { ChatModule } from "./ChatModule";
import { arrayBufferToBase64, base64ToArrayBuffer } from "obsidian";

export class DocumentExtractor {
  constructor(
    private chatModule: ChatModule,
    private app: App
  ) {}

  async extractDocument(
    file: TFile
  ): Promise<{ markdown: string; images: { [key: string]: string } }> {
    const fileExtension = file.extension.toLowerCase();

    if (["pdf", "docx", "pptx"].includes(fileExtension)) {
      const fileContent = await this.app.vault.readBinary(file);
      const result = await this.sendToMarkerAPI(fileContent, file);
      await this.writeExtractedContent(result, file);
      return result;
    } else if (["png", "jpg", "jpeg", "gif"].includes(fileExtension)) {
      const content = await this.app.vault.readBinary(file);
      const base64Image = arrayBufferToBase64(content);
      return {
        markdown: `![${file.name}](data:image/${file.extension};base64,${base64Image})`,
        images: { [file.name]: base64Image },
      };
    } else if (fileExtension === "md") {
      const content = await this.app.vault.read(file);
      return {
        markdown: content,
        images: {},
      };
    } else {
      throw new Error(`Unsupported file type: ${fileExtension}`);
    }
  }

  private async sendToMarkerAPI(fileContent: ArrayBuffer, file: TFile) {
    const boundary =
      "----WebKitFormBoundary" + Math.random().toString(36).substring(2);
    const formData = this.createFormData(fileContent, file, boundary);

    const response = await requestUrl({
      url:
        this.chatModule.settings.apiEndpoint === "datalab"
          ? "https://www.datalab.to/api/v1/marker"
          : `http://${this.chatModule.settings.markerEndpoint}/convert`,
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        ...(this.chatModule.settings.apiEndpoint === "datalab" && {
          "X-Api-Key": this.chatModule.settings.markerApiKey,
        }),
      },
    });

    if (response.status >= 400) {
      throw new Error(`API error: ${response.status}`);
    }

    if (this.chatModule.settings.apiEndpoint === "datalab") {
      return this.pollForResult(response.json.request_check_url);
    }
    return response.json;
  }

  private async pollForResult(checkUrl: string) {
    let attempts = 300;
    while (attempts > 0) {
      const response = await requestUrl({
        url: checkUrl,
        method: "GET",
        headers: {
          "X-Api-Key": this.chatModule.settings.markerApiKey,
        },
      });

      const data = response.json;
      if (data.status === "complete") {
        return data;
      }

      attempts--;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error("Processing timeout");
  }

  private createFormData(
    fileContent: ArrayBuffer,
    file: TFile,
    boundary: string
  ): ArrayBuffer {
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${this.getContentType(file.extension)}\r\n\r\n`,
      fileContent,
      "\r\n",
      `--${boundary}\r\nContent-Disposition: form-data; name="extract_images"\r\n\r\ntrue\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="force_ocr"\r\n\r\ntrue\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="paginate"\r\n\r\ntrue\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="langs"\r\n\r\n${this.chatModule.settings.langs}\r\n`,
      `--${boundary}--\r\n`,
    ];

    const textEncoder = new TextEncoder();
    const buffers = parts.map((part) =>
      typeof part === "string" ? textEncoder.encode(part) : new Uint8Array(part)
    );

    const totalLength = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
    const result = new Uint8Array(totalLength);

    let offset = 0;
    for (const buffer of buffers) {
      result.set(buffer, offset);
      offset += buffer.byteLength;
    }

    return result.buffer;
  }

  private async writeExtractedContent(
    data: { markdown: string; images: { [key: string]: string } },
    originalFile: TFile
  ) {
    const folderPath = `${originalFile.parent?.path || ""}/${originalFile.basename}`;

    // Create extraction folder
    try {
      await this.app.vault.adapter.mkdir(folderPath);
    } catch (error) {
      // Ignore if folder exists
    }

    // Write markdown content
    const markdownPath = `${folderPath}/extracted_content.md`;
    try {
      await this.app.vault.adapter.write(markdownPath, data.markdown);
    } catch (error) {
      if (error instanceof Error && error.message.includes("already exists")) {
        await this.app.vault.adapter.remove(markdownPath);
        await this.app.vault.adapter.write(markdownPath, data.markdown);
      } else {
        throw error;
      }
    }

    // Write images
    for (const [imageName, imageBase64] of Object.entries(data.images)) {
      const imagePath = `${folderPath}/${imageName}`;
      const imageBuffer = base64ToArrayBuffer(imageBase64);

      try {
        await this.app.vault.adapter.writeBinary(imagePath, imageBuffer);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("already exists")
        ) {
          await this.app.vault.adapter.remove(imagePath);
          await this.app.vault.adapter.writeBinary(imagePath, imageBuffer);
        } else {
          throw error;
        }
      }
    }
  }

  private getContentType(extension: string): string {
    const types: Record<string, string> = {
      pdf: "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    };
    return types[extension.toLowerCase()] || "application/octet-stream";
  }
}
