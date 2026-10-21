// A journal's state as last saved. Each change is made from the state the
// changes before it saved, saved in order, and seen only once it is saved, so
// what anyone reads is on disk. A failed save changes nothing and rejects
// only its own change.
export class SavedState<T> {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private value: T,
    private readonly save: (value: T) => Promise<void>,
  ) {}
  get current() {
    return this.value;
  }
  /** Saves `next(current)` once earlier changes settled; returning the same
   * value saves nothing. */
  change(next: (value: T) => T): Promise<void> {
    const run = this.queue.then(async () => {
      const value = next(this.value);
      if (value === this.value) return;
      await this.save(value);
      this.value = value;
    });
    this.queue = run.catch(() => {});
    return run;
  }
  /** Settles once every change made so far has. */
  settled(): Promise<void> {
    return this.queue.then(() => {});
  }
}
