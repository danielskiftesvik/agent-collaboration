export class AsyncPool {
  constructor(options = {}) {
    this.concurrency = options.concurrency ?? 1;
    this.active = 0;
    this.queue = [];
    this.isPaused = false;
  }

  run(task, options = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, options, resolve, reject, attempts: 0 });
      this._dispatch();
    });
  }

  pause() {
    this.isPaused = true;
  }

  resume() {
    this.isPaused = false;
    this._dispatch();
  }

  _dispatch() {
    if (this.isPaused || this.active >= this.concurrency || this.queue.length === 0) {
      return;
    }

    const item = this.queue.shift();
    this.active++;

    let settled = false;
    let timer = null;

    const onComplete = () => {
      if (timer) clearTimeout(timer);
      if (!settled) {
        settled = true;
        this.active--;
        this._dispatch();
      }
    };

    const execute = async () => {
      try {
        const result = await item.task();
        onComplete();
        item.resolve(result);
      } catch (err) {
        if (item.attempts < (item.options.retries ?? 0)) {
          item.attempts++;
          const backoff = 10 * Math.pow(2, item.attempts - 1);
          setTimeout(() => {
            execute();
          }, backoff);
        } else {
          onComplete();
          item.reject(err);
        }
      }
    };

    if (item.options.timeout !== undefined) {
      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.active--;
          this._dispatch();
          item.reject(new Error("Timeout"));
        }
      }, item.options.timeout);
    }

    execute();
  }
}
