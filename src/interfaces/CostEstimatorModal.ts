import { Modal, App } from 'obsidian';

export class CostEstimator extends Modal {
  modelId: string;
  tokenCount: number;
  maxTokens: number;

  constructor(
    app: App,
    modelId: string,
    tokenCount: number,
    maxTokens: number
  ) {
    super(app);
    this.modelId = modelId;
    this.tokenCount = tokenCount;
    this.maxTokens = maxTokens;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Cost Estimator' });
    contentEl.createEl('p', {
      text: `Currently Selected Model: ${this.modelId}`,
      cls: 'current-model',
    });

    // Calculate and display cost for the current model
    const modelCosts = {
      'gpt-4o': {
        perThousandInput: 0.005,
        perThousandOutput: 0.015,
      },
      'gpt-3.5-turbo': {
        perThousandInput: 0.0005,
        perThousandOutput: 0.0015,
      },
    };

    if (modelCosts[this.modelId]) {
      const perThousandInput = modelCosts[this.modelId].perThousandInput;
      const perThousandOutput = modelCosts[this.modelId].perThousandOutput;

      const inputCost = this.tokenCount * perThousandInput;
      const minOutputCost = 1 * perThousandOutput;
      const maxOutputCost = this.maxTokens * perThousandOutput;
      const minTotalCost = inputCost + minOutputCost;
      const maxTotalCost = inputCost + maxOutputCost;

      console.log(
        'Input cost is ',
        inputCost,
        ', min output cost is ',
        minOutputCost,
        ', max output cost is ',
        maxOutputCost,
        ', min total cost is ',
        minTotalCost,
        ', max total cost is ',
        maxTotalCost
      );

      const tokenInfoContainer = contentEl.createDiv({
        cls: 'token-info-container',
      });

      tokenInfoContainer.createEl('div', {
        text: `Current input tokens: ${this.tokenCount} (Estimated $${(
          inputCost / 1000
        ).toFixed(2)})`,
        cls: 'token-info latest-token-count',
      });

      tokenInfoContainer.createEl('div', {
        text: `Max output tokens: ${this.maxTokens} (Estimated $${(
          minOutputCost / 1000
        ).toFixed(2)} - $${(maxOutputCost / 1000).toFixed(2)})`,
        cls: 'token-info max-tokens-setting',
      });

      contentEl.createEl('p', {
        text: `Predicted next chat cost: $${(minTotalCost / 1000).toFixed(
          2
        )} - $${(maxTotalCost / 1000).toFixed(2)}*`,
        cls: 'predicted-cost',
      });

      contentEl.createEl('p', {
        text: '* This is the range of possible costs. The actual cost is usually on the lower end as the response from the LLM often does not utilize all possible output tokens unless the output requested is specifically lengthy.',
        cls: 'cost-notice',
      });
    }

    const costTypeTabs = `
      <div class="tabs cost-type-tabs">
        <button class="tab-button" data-cost-type="thousand">Per Thousand Cost</button>
        <button class="tab-button active" data-cost-type="million">Per Million Cost</button>
      </div>
    `;

    const tableHtml = `
      <h3>OpenAI API Models</h3>
      <table class="cost-table">
        <tr>
          <th>Model</th>
          <th>Input</th>
          <th>Output</th>
        </tr>
        <tr>
          <td>gpt-4o</td>
          <td class="cost-input" data-thousand="0.005" data-million="5.00">$5.00 / 1M tokens</td>
          <td class="cost-output" data-thousand="0.015" data-million="15.00">$15.00 / 1M tokens</td>
        </tr>
        <tr>
          <td>gpt-3.5-turbo</td>
          <td class="cost-input" data-thousand="0.0005" data-million="0.50">$0.50 / 1M tokens</td>
          <td class="cost-output" data-thousand="0.0015" data-million="1.50">$1.50 / 1M tokens</td>
        </tr>
      </table>

      <h3>Groq Models</h3>
      <div class="tabs groq-model-tabs">
        <button class="tab-button active" data-tab="free">Free Version</button>
        <button class="tab-button" data-tab="on-demand">On-Demand Version</button>
      </div>
      <div class="tab-content" id="free" style="display:block;">
        <table class="cost-table">
          <tr>
            <th>Model</th>
            <th>Input</th>
            <th>Output</th>
          </tr>
          <tr>
            <td>Llama3-70B-8k</td>
            <td>Free</td>
            <td>Free</td>
          </tr>
          <tr>
            <td>Llama3-8B-8k</td>
            <td>Free</td>
            <td>Free</td>
          </tr>
          <tr>
            <td>Mixtral-8x7B-32k Instruct</td>
            <td>Free</td>
            <td>Free</td>
          </tr>
          <tr>
            <td>Gemma-7B-Instruct</td>
            <td>Free</td>
            <td>Free</td>
          </tr>
        </table>
      </div>
      <div class="tab-content" id="on-demand" style="display:none;">
        <table class="cost-table">
          <tr>
            <th>Model</th>
            <th>Input</th>
            <th>Output</th>
          </tr>
          <tr>
            <td>Llama3-70B-8k</td>
            <td class="cost-input" data-thousand="0.00059" data-million="0.59">$0.59 / 1M tokens</td>
            <td class="cost-output" data-thousand="0.00079" data-million="0.79">$0.79 / 1M tokens</td>
          </tr>
          <tr>
            <td>Llama3-8B-8k</td>
            <td class="cost-input" data-thousand="0.00005" data-million="0.05">$0.05 / 1M tokens</td>
            <td class="cost-output" data-thousand="0.00010" data-million="0.10">$0.10 / 1M tokens</td>
          </tr>
          <tr>
            <td>Mixtral-8x7B-32k Instruct</td>
            <td class="cost-input" data-thousand="0.00027" data-million="0.27">$0.27 / 1M tokens</td>
            <td class="cost-output" data-thousand="0.00027" data-million="0.27">$0.27 / 1M tokens</td>
          </tr>
          <tr>
            <td>Gemma-7B-Instruct</td>
            <td class="cost-input" data-thousand="0.00010" data-million="0.10">$0.10 / 1M tokens</td>
            <td class="cost-output" data-thousand="0.00010" data-million="0.10">$0.10 / 1M tokens</td>
          </tr>
        </table>
      </div>
    `;

    contentEl.innerHTML += costTypeTabs + tableHtml;

    this.registerCostTypeEvents();
    this.registerTabEvents();
  }

  registerCostTypeEvents() {
    const costTypeButtons = this.contentEl.querySelectorAll(
      '.cost-type-tabs .tab-button[data-cost-type]'
    );
    const costInputs = this.contentEl.querySelectorAll('.cost-input');
    const costOutputs = this.contentEl.querySelectorAll('.cost-output');

    costTypeButtons.forEach(button => {
      button.addEventListener('click', () => {
        costTypeButtons.forEach(btn => btn.classList.remove('active'));
        button.classList.add('active');

        const costType = button.getAttribute('data-cost-type');
        const unit = costType === 'thousand' ? '1K' : '1M';

        costInputs.forEach(input => {
          input.textContent = `$${input.getAttribute(
            `data-${costType}`
          )} / ${unit} tokens`;
        });
        costOutputs.forEach(output => {
          output.textContent = `$${output.getAttribute(
            `data-${costType}`
          )} / ${unit} tokens`;
        });
      });
    });
  }

  registerTabEvents() {
    const tabButtons = this.contentEl.querySelectorAll(
      '.groq-model-tabs .tab-button'
    );
    const tabContents = this.contentEl.querySelectorAll('.tab-content');

    tabButtons.forEach(button => {
      button.addEventListener('click', () => {
        tabButtons.forEach(btn => btn.classList.remove('active'));
        button.classList.add('active');

        const target = button.getAttribute('data-tab');
        tabContents.forEach(content => {
          (content as HTMLElement).style.display =
            content.id === target ? 'block' : 'none';
        });
      });
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
