export class InProcessQueue {
  private running = false;
  private tasks: Array<() => Promise<void>> = [];

  enqueue(task: () => Promise<void>): void {
    this.tasks.push(task);
    void this.run();
  }

  private async run(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      while (this.tasks.length > 0) {
        const next = this.tasks.shift();
        if (!next) {
          continue;
        }

        try {
          await next();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Execute queue task failed: ${message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
