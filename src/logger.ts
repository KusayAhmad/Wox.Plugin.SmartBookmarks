export class Logger {
  private static prefix = '[SmartBookmarks]';

  static log(message: string, ...args: any[]): void {
    console.log(`${this.prefix} ${message}`, ...args);
  }

  static error(message: string, ...args: any[]): void {
    console.error(`${this.prefix} ${message}`, ...args);
  }

  static warn(message: string, ...args: any[]): void {
    console.warn(`${this.prefix} ${message}`, ...args);
  }

  static debug(message: string, ...args: any[]): void {
    console.debug(`${this.prefix} ${message}`, ...args);
  }

  static info(message: string, ...args: any[]): void {
    console.info(`${this.prefix} ${message}`, ...args);
  }
}
