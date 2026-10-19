/** Cola asíncrona push→pull con cierre; implementa AsyncIterable. */
export class Channel<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value, done: false });
    else this.queue.push(value);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift() as T, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
