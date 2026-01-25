import chalk from 'chalk';

export class BuildLogger {
    constructor(prefix) {
        this.prefix = prefix;
    }

    log(level, message, detail = '') {
        const timestamp = new Date().toLocaleTimeString();
        const prefix = `[${this.prefix}]`;
        
        switch(level) {
            case 'info':
                console.log(chalk.blue(prefix), message, detail);
                break;
            case 'success':
                console.log(chalk.green(prefix), chalk.green('✓'), message, detail);
                break;
            case 'warn':
                console.log(chalk.yellow(prefix), chalk.yellow('⚠'), message, detail);
                break;
            case 'error':
                console.log(chalk.red(prefix), chalk.red('✗'), message, detail);
                break;
            case 'debug':
                console.log(chalk.gray(prefix), message, detail);
                break;
            default:
                console.log(prefix, message, detail);
        }
    }

    info(message, detail = '') {
        this.log('info', message, detail);
    }

    success(message, detail = '') {
        this.log('success', message, detail);
    }

    warn(message, detail = '') {
        this.log('warn', message, detail);
    }

    error(message, detail = '') {
        this.log('error', message, detail);
    }

    debug(message, detail = '') {
        this.log('debug', message, detail);
    }

    divider() {
        console.log(chalk.gray('─'.repeat(60)));
    }
}

export function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    const seconds = (ms / 1000).toFixed(2);
    return `${seconds}s`;
}