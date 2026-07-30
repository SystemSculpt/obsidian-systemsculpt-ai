class AgentClient extends EventTarget {
  constructor() {
    super();
    this.ready = Promise.resolve();
  }

  send() {}
  close() {}
}

module.exports = { AgentClient };
