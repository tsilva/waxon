/** Bounded, single-flight cache for read data. Authentication stays outside it. */
export class ExpiringCache<K, V> {
  private entries = new Map<K, { value: V; expiresAt: number }>();
  private pending = new Map<K, Promise<V>>();

  constructor(private readonly ttlMs: number, private readonly maxEntries: number) {}

  delete(key: K) {
    this.entries.delete(key);
    this.pending.delete(key);
  }

  async get(key: K, load: () => Promise<V>): Promise<V> {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    this.entries.delete(key);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const request = load().then((value) => {
      if (this.pending.get(key) === request) {
        this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
        while (this.entries.size > this.maxEntries) {
          this.entries.delete(this.entries.keys().next().value!);
        }
      }
      return value;
    }).finally(() => {
      if (this.pending.get(key) === request) this.pending.delete(key);
    });
    this.pending.set(key, request);
    return request;
  }
}
