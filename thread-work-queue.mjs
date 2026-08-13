export class ThreadWorkQueue {
  #tails = new Map();
  #queued = 0;

  get queuedCount() {
    return this.#queued;
  }

  enqueue(threadId, task) {
    if (!threadId) throw new Error("threadId is required");
    this.#queued += 1;
    const previous = this.#tails.get(threadId) ?? Promise.resolve();
    const runTask = async () => {
      this.#queued -= 1;
      return task();
    };
    const result = previous.then(runTask, runTask);
    const tail = result.then(() => undefined, () => undefined);
    this.#tails.set(threadId, tail);
    void tail.finally(() => {
      if (this.#tails.get(threadId) === tail) this.#tails.delete(threadId);
    });
    return result;
  }
}
