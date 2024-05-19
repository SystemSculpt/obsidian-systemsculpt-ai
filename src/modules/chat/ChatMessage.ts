export class ChatMessage {
  role: 'user' | 'ai';
  text: string;

  constructor(role: 'user' | 'ai', text: string) {
    this.role = role;
    this.text = text;
  }
}
