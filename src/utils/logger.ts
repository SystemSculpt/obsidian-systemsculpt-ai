const development = false;

function getPreMessage(): string {
  return `[SYSTEMSCULPT] ${new Date()
    .toISOString()
    .slice(11, 19)}.${new Date().getMilliseconds()}\n`;
}

export const logger = {
  log(...args: any[]): void {
    if (development) {
      console.log(getPreMessage(), ...args);
    }
  },

  error(...args: any[]): void {
    if (development) {
      console.error(getPreMessage(), ...args);
    }
  },

  warn(...args: any[]): void {
    if (development) {
      console.warn(getPreMessage(), ...args);
    }
  },

  info(...args: any[]): void {
    if (development) {
      console.info(getPreMessage(), ...args);
    }
  },

  trace: (message: string, ...args: any[]) => {
    const stack = new Error().stack;
    if (stack) {
      const callerLine = stack.split("\n")[2]; // Get the caller's line
      const match = callerLine.match(
        /at (?:(.+?)\s+\()?(?:(.+?):(\d+)(?::(\d+))?)\)?/,
      );
      const filePath = match ? match[2] : "unknown";
      const lineNumber = match ? match[3] : "unknown";
      console.log(
        `[SYSTEMSCULPT] ${new Date().toLocaleTimeString()} [${filePath}:${lineNumber}]`,
        message,
        ...args,
      );
    } else {
      console.log(
        `[SYSTEMSCULPT] ${new Date().toLocaleTimeString()}`,
        message,
        ...args,
      );
    }
  },
};
