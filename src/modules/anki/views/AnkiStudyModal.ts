import { App, Modal, MarkdownRenderer } from "obsidian";
import { AnkiModule } from "../AnkiModule";

export class AnkiStudyModal extends Modal {
  private currentCardIndex: number = 0;
  private totalCards: number = 0;
  private cards: { question: string; answer: string }[] = [];
  private answerRevealed: boolean = false;

  constructor(
    app: App,
    private plugin: AnkiModule,
    private noteContent: string
  ) {
    super(app);
    this.registerKeyboardShortcuts();
  }

  private registerKeyboardShortcuts(): void {
    this.scope.register([], "ArrowRight", (evt: KeyboardEvent) => {
      evt.preventDefault();
      if (!this.answerRevealed) {
        this.showAnswer();
      } else if (this.currentCardIndex < this.totalCards - 1) {
        this.nextCard();
      }
    });

    this.scope.register([], "ArrowLeft", (evt: KeyboardEvent) => {
      evt.preventDefault();
      if (this.answerRevealed) {
        this.hideAnswer();
      } else if (this.currentCardIndex > 0) {
        this.previousCard();
      }
    });

    this.scope.register([], "ArrowDown", (evt: KeyboardEvent) => {
      evt.preventDefault();
      if (this.answerRevealed) {
        const currentCard = this.cards[this.currentCardIndex];
        this.cards.splice(this.currentCardIndex, 1);
        const newPosition =
          this.currentCardIndex +
          1 +
          Math.floor(
            Math.random() * (this.cards.length - this.currentCardIndex)
          );
        this.cards.splice(newPosition, 0, currentCard);
        this.answerRevealed = false;
        this.renderCard();
      }
    });
  }

  private showAnswer(): void {
    this.answerRevealed = true;
    this.renderCard();
  }

  private hideAnswer(): void {
    this.answerRevealed = false;
    this.renderCard();
  }

  private nextCard(): void {
    this.currentCardIndex++;
    this.answerRevealed = false;
    this.renderCard();
  }

  private previousCard(): void {
    this.currentCardIndex--;
    this.answerRevealed = false;
    this.renderCard();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("systemsculpt-modal-content-centered");

    this.parseCards();
    this.shuffleCards();
    this.renderCard();
  }

  private parseCards() {
    const lines = this.noteContent.split("\n");
    let currentQuestion = "";
    let currentAnswer = "";
    let isCollectingAnswer = false;
    let answerLines: string[] = [];

    lines.forEach((line) => {
      if (line.startsWith("## ")) {
        if (currentQuestion && answerLines.length > 0) {
          // Remove trailing newlines and dashes
          const cleanAnswer = answerLines
            .join("\n")
            .replace(/\n*---\s*$/, "")
            .trim();
          this.cards.push({ question: currentQuestion, answer: cleanAnswer });
          answerLines = [];
        }
        currentQuestion = line.substring(3).trim();
        isCollectingAnswer = false;
      } else if (line.startsWith("### Anki Answer")) {
        isCollectingAnswer = true;
      } else if (isCollectingAnswer) {
        answerLines.push(line);
      }
    });

    // Add the last card if exists
    if (currentQuestion && answerLines.length > 0) {
      const cleanAnswer = answerLines
        .join("\n")
        .replace(/\n*---\s*$/, "")
        .trim();
      this.cards.push({ question: currentQuestion, answer: cleanAnswer });
    }

    this.totalCards = this.cards.length;
  }

  private shuffleCards() {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
  }

  private async renderCard() {
    const { contentEl } = this;
    contentEl.empty();

    // Header with progress
    const header = contentEl.createEl("h2", {
      text: `Card ${this.currentCardIndex + 1} of ${this.totalCards}`,
    });
    header.addClass("systemsculpt-modal-header");

    // Question section
    const questionContainer = contentEl.createDiv("systemsculpt-info-box");
    const questionText = questionContainer.createEl("p", {
      text: this.cards[this.currentCardIndex].question,
    });
    questionText.style.fontSize = "1.5em";
    questionText.style.margin = "1em 0";

    // Answer section - always show but blur when not revealed
    const answerContainer = contentEl.createDiv("systemsculpt-info-box");
    if (!this.answerRevealed) {
      answerContainer.style.filter = "blur(5px)";
      answerContainer.style.userSelect = "none";
      answerContainer.style.pointerEvents = "none";
    }
    const answerContent = answerContainer.createDiv();
    await MarkdownRenderer.renderMarkdown(
      this.cards[this.currentCardIndex].answer,
      answerContent,
      "",
      this.plugin.plugin
    );

    // Button container
    const buttonContainer = contentEl.createDiv(
      "systemsculpt-modal-button-container"
    );
    buttonContainer.style.display = "flex";
    buttonContainer.style.justifyContent = "space-between";
    buttonContainer.style.width = "100%";
    buttonContainer.style.padding = "0 20px";

    if (!this.answerRevealed) {
      const showAnswerButton = buttonContainer.createEl("button", {
        text: "Show Answer",
      });
      showAnswerButton.style.margin = "0 auto";
      showAnswerButton.addEventListener("click", () => this.showAnswer());
    } else {
      const leftContainer = buttonContainer.createDiv();
      leftContainer.style.flex = "1";
      if (this.currentCardIndex > 0) {
        const prevButton = leftContainer.createEl("button", {
          text: "Previous",
        });
        prevButton.addEventListener("click", () => this.previousCard());
      }

      const centerContainer = buttonContainer.createDiv();
      centerContainer.style.flex = "1";
      centerContainer.style.display = "flex";
      centerContainer.style.justifyContent = "center";
      const reshuffleButton = centerContainer.createEl("button", {
        text: "Reshuffle",
      });
      reshuffleButton.addEventListener("click", () => {
        const currentCard = this.cards[this.currentCardIndex];
        this.cards.splice(this.currentCardIndex, 1);
        const newPosition =
          this.currentCardIndex +
          1 +
          Math.floor(
            Math.random() * (this.cards.length - this.currentCardIndex)
          );
        this.cards.splice(newPosition, 0, currentCard);
        this.answerRevealed = false;
        this.renderCard();
      });

      const rightContainer = buttonContainer.createDiv();
      rightContainer.style.flex = "1";
      rightContainer.style.display = "flex";
      rightContainer.style.justifyContent = "flex-end";
      if (this.currentCardIndex < this.totalCards - 1) {
        const nextButton = rightContainer.createEl("button", {
          text: "Next",
        });
        nextButton.addEventListener("click", () => this.nextCard());
      } else {
        const finishButton = rightContainer.createEl("button", {
          text: "Finish",
        });
        finishButton.addEventListener("click", () => this.close());
      }
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
