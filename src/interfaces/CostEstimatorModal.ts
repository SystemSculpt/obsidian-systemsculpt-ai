import { Modal, App, setIcon } from "obsidian";
import { Model } from "../api/Model";

export class CostEstimator extends Modal {
  private model: Model;
  private tokenCount: number;
  private maxOutputTokens: number;

  constructor(app: App, model: Model, tokenCount: number) {
    super(app);
    this.model = model;
    this.tokenCount = tokenCount;
    this.maxOutputTokens = model.maxOutputTokens || 4096;
  }

  public static calculateCost(
    model: Model,
    tokenCount: number,
    maxOutputTokens: number
  ): { minCost: number; maxCost: number } {
    if (!model.pricing) {
      return { minCost: 0, maxCost: 0 };
    }
    const { prompt: inputCost, completion: outputCost } = model.pricing;
    const minCost = tokenCount * inputCost;
    const maxCost = tokenCount * inputCost + maxOutputTokens * outputCost;
    return { minCost, maxCost };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("systemsculpt-cost-estimator-modal");

    this.createHeader(contentEl);
    this.createModelInfo(contentEl);
    this.createTokenInfo(contentEl);
    this.createCostEstimate(contentEl);
  }

  private createHeader(contentEl: HTMLElement) {
    const header = contentEl.createEl("div", {
      cls: "systemsculpt-modal-header",
    });
    setIcon(
      header.createEl("span", { cls: "systemsculpt-modal-icon" }),
      "calculator"
    );
    header.createEl("h2", {
      text: "Cost Estimator",
      cls: "systemsculpt-modal-title",
    });
  }

  private createModelInfo(contentEl: HTMLElement) {
    const modelInfo = contentEl.createEl("div", {
      cls: "systemsculpt-model-info",
    });
    modelInfo.createEl("h3", { text: "Selected Model" });
    modelInfo.createEl("p", {
      text: this.model.name,
      cls: "systemsculpt-model-name",
    });

    if (this.model.pricing) {
      const pricePerMillionInput = this.model.pricing.prompt * 1000000;
      const pricePerMillionOutput = this.model.pricing.completion * 1000000;

      const pricingInfo = modelInfo.createEl("div", {
        cls: "systemsculpt-pricing-info",
      });
      pricingInfo.createEl("p", {
        text: `$${this.formatNumber(
          pricePerMillionInput
        )} per million input tokens`,
        cls: "systemsculpt-pricing-detail",
      });
      pricingInfo.createEl("p", {
        text: `$${this.formatNumber(
          pricePerMillionOutput
        )} per million output tokens`,
        cls: "systemsculpt-pricing-detail",
      });
    }
  }

  private createTokenInfo(contentEl: HTMLElement) {
    const tokenInfo = contentEl.createEl("div", {
      cls: "systemsculpt-token-info-container",
    });
    const leftTokenInfo = tokenInfo.createEl("div", {
      cls: "systemsculpt-token-info systemsculpt-left",
    });
    leftTokenInfo.createEl("span", { text: "Current input tokens:" });
    leftTokenInfo.createEl("span", {
      text: this.tokenCount.toString(),
      cls: "systemsculpt-token-value",
    });

    const rightTokenInfo = tokenInfo.createEl("div", {
      cls: "systemsculpt-token-info systemsculpt-right",
    });
    rightTokenInfo.createEl("span", { text: "Max output tokens:" });
    rightTokenInfo.createEl("span", {
      text: this.maxOutputTokens.toString(),
      cls: "systemsculpt-token-value",
    });
  }

  private createCostEstimate(contentEl: HTMLElement) {
    const costEstimate = contentEl.createEl("div", {
      cls: "systemsculpt-predicted-cost",
    });
    costEstimate.createEl("h3", { text: "Estimated Cost for Next Message" });
    const costInfo = costEstimate.createEl("p", { cls: "systemsculpt-value" });

    if (this.model.provider === "local") {
      costInfo.innerHTML =
        "Local model detected. No cost calculation available.";
    } else if (this.model.pricing) {
      const { prompt: inputCost, completion: outputCost } = this.model.pricing;
      const minCost = this.tokenCount * inputCost + outputCost;
      const maxCost =
        this.tokenCount * inputCost + this.maxOutputTokens * outputCost;
      costInfo.innerHTML = `$${this.formatNumber(
        minCost
      )} - $${this.formatNumber(maxCost)}`;

      const disclaimer = contentEl.createEl("p", {
        cls: "systemsculpt-cost-notice",
      });
      disclaimer.innerHTML =
        "This is a rough estimate. Actual cost may vary based on the specific content and length of the message.";
    } else {
      costInfo.innerHTML =
        "Pricing information is not available for this model.";
    }
  }

  private formatNumber(num: number): string {
    if (num === 0) return "0.00";
    if (num >= 1) return num.toFixed(2);

    const fixed = num.toFixed(10);
    const [integer, decimal] = fixed.split(".");

    if (decimal.startsWith("00")) {
      const significantIndex = decimal.split("").findIndex((d) => d !== "0");
      if (significantIndex === -1) {
        // If there are no non-zero digits, return with all zeros
        return `${integer}.${"0".repeat(10)}`;
      }
      const significantDigits = decimal.slice(
        significantIndex,
        significantIndex + 2
      );
      return `${integer}.${"0".repeat(
        Math.max(0, significantIndex)
      )}${significantDigits}`;
    }

    return Number(fixed).toFixed(2);
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
