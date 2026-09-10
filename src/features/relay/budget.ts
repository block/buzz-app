/** Deterministic UTF-8 budget, used for both warm data and persisted records. */
export const byteSize = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

export class ByteLru<T> {
  private items = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;
  constructor(
    readonly maxEntries: number,
    readonly maxBytes: number,
  ) {}
  get(key: string): T | undefined {
    const entry = this.items.get(key);
    if (!entry) return;
    this.items.delete(key);
    this.items.set(key, entry);
    return entry.value;
  }
  peek(key: string) {
    return this.items.get(key)?.value;
  }
  set(key: string, value: T, bytes = byteSize(value)): boolean {
    this.delete(key);
    if (bytes > this.maxBytes || this.maxEntries < 1) return false;
    this.items.set(key, { value, bytes });
    this.bytes += bytes;
    for (const oldest of this.items.keys()) {
      if (this.items.size <= this.maxEntries && this.bytes <= this.maxBytes)
        break;
      this.delete(oldest);
    }
    return true;
  }
  delete(key: string) {
    const entry = this.items.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.items.delete(key);
  }
  clear() {
    this.items.clear();
    this.bytes = 0;
  }
  keys() {
    return [...this.items.keys()];
  }
  entries(): [string, T][] {
    return [...this.items].map(([key, entry]) => [key, entry.value]);
  }
  stats() {
    return { entries: this.items.size, bytes: this.bytes };
  }
}
