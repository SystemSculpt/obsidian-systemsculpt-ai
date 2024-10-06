export class ChatMessage {
  role: "user" | "ai";
  text: string;
  model?: string; // Added this line

  constructor(role: "user" | "ai", text: string, model?: string) {
    this.role = role;
    this.text = text;
    this.model = model; // Added this line
  }
}
