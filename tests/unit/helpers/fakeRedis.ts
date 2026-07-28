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

  set(key: string, value: string): Promise<'OK'> {
    this.store.set(key, value);
    return Promise.resolve('OK');
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
