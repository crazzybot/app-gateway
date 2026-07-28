import { describe, expect, it, vi } from 'vitest';

vi.mock('ioredis', async () => {
  const { FakeRedis } = await import('./helpers/fakeRedis.js');
  return { Redis: FakeRedis };
});

// Must run before the first (dynamic) import of anything that transitively
// imports env.ts — env.ts parses process.env once, at module load.
process.env['JWT_PREVIOUS_KID'] = '22222222-2222-4222-8222-222222222222';
process.env['JWT_PREVIOUS_PUBLIC_KEY_PATH'] = './tests/fixtures/keys/previous-public.pem';

const { getJwks } = await import('@/services/token.service.js');

describe('getJwks with a configured previous key (FR-21 rotation window)', () => {
  it('publishes both the active and previous public keys', async () => {
    const jwks = await getJwks();

    expect(jwks.keys).toHaveLength(2);
    const kids = jwks.keys.map((k) => k.kid);
    expect(kids).toContain('11111111-1111-4111-8111-111111111111');
    expect(kids).toContain('22222222-2222-4222-8222-222222222222');
    expect(jwks.keys.every((k) => k.use === 'sig' && k.alg === 'RS256')).toBe(true);
  });
});
