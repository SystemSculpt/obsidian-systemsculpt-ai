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
};
