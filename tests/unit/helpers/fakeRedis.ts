/**
 * In-memory stand-in for the `ioredis` client, registered via
 * `vi.mock('ioredis', () => ({ Redis: FakeRedis }))` in test files that
 * import token.service.ts (which opens a real Redis connection at module
 * load). CLAUDE.md: "Unit tests may mock ioredis ... with vi.mock".
 */

export class FakeRedis {
  private readonly store = new Map<string, string>();

  on(): this {
    return this;
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.has(key) ? (this.store.get(key) as string) : null);
  }

  // Real ioredis accepts trailing option flags (e.g. 'EX', ttlSeconds, 'NX')
  // as variadic args of mixed type — only NX is behaviorally relevant to any
  // caller in this codebase, so that's the only flag this fake honors.
  set(key: string, value: string, ...options: (string | number)[]): Promise<'OK' | null> {
    const nx = options.some((opt) => typeof opt === 'string' && opt.toUpperCase() === 'NX');
    if (nx && this.store.has(key)) {
      return Promise.resolve(null);
    }
    this.store.set(key, value);
    return Promise.resolve('OK');
  }

  del(key: string): Promise<number> {
    return Promise.resolve(this.store.delete(key) ? 1 : 0);
  }

  incr(key: string): Promise<number> {
    const next = (Number(this.store.get(key)) || 0) + 1;
    this.store.set(key, String(next));
    return Promise.resolve(next);
  }

  pexpire(): Promise<number> {
    return Promise.resolve(1);
  }

  ping(): Promise<'PONG'> {
    return Promise.resolve('PONG');
  }

  quit(): Promise<'OK'> {
    return Promise.resolve('OK');
  }
}
