import chalk from "chalk";

if (chalk.level < 2) {
    chalk.level = 2;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
    private timer: NodeJS.Timeout | null = null;
    private index = 0;
    private text = "";
    private isTTY: boolean;

    constructor() {
        this.isTTY = !!(process.stdout && process.stdout.isTTY);
    }

    start(text: string): void {
        this.text = text;
        if (!this.isTTY) {
            process.stdout.write(`${chalk.cyan("→")} ${text}\n`);
            return;
        }
        process.stdout.write("\x1B[?25l"); // hide cursor
        this.render();
        this.timer = setInterval(() => {
            this.index = (this.index + 1) % FRAMES.length;
            this.render();
        }, 80);
    }

    update(text: string): void {
        if (text === this.text) return; // no-op if message hasn't changed
        this.text = text;
        if (!this.isTTY) {
            process.stdout.write(`${chalk.cyan("→")} ${text}\n`);
            return;
        }
        this.render();
    }

    succeed(text?: string): void {
        this.stop();
        const msg = text ?? this.text;
        console.log(`${chalk.greenBright("✓")} ${msg}`);
    }

    fail(text?: string): void {
        this.stop();
        const msg = text ?? this.text;
        console.log(`${chalk.redBright("✗")} ${msg}`);
    }

    info(text?: string): void {
        this.stop();
        const msg = text ?? this.text;
        console.log(`${chalk.cyanBright("ℹ")} ${msg}`);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.isTTY) {
            process.stdout.write("\r\x1B[K");   // clear line
            process.stdout.write("\x1B[?25h");  // restore cursor
        }
    }

    private render(): void {
        if (!this.isTTY) return;
        const frame = chalk.cyanBright(FRAMES[this.index]);
        process.stdout.write(`\r\x1B[K${frame} ${chalk.whiteBright(this.text)}`);
    }
}
