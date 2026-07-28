import request, { type Response } from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '@/index.js';
import { closeConnections } from './helpers/closeConnections.js';

interface JwksResponseBody {
  keys: Array<{
    kty: string;
    use: string;
    alg: string;
    kid: string;
    n: string;
    e: string;
    d?: string;
  }>;
}

function body(res: Response): JwksResponseBody {
  return res.body as JwksResponseBody;
}

afterAll(async () => {
  await closeConnections();
});

describe('GET /v1/auth/.well-known/jwks.json (FR-21, AC-31)', () => {
  it('publishes the active public key with the expected JWK fields', async () => {
    const res = await request(app).get('/v1/auth/.well-known/jwks.json');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    const jwks = body(res);
    expect(Array.isArray(jwks.keys)).toBe(true);
    expect(jwks.keys.length).toBeGreaterThanOrEqual(1);

    const key = jwks.keys[0];
    expect(key?.kty).toBe('RSA');
    expect(key?.use).toBe('sig');
    expect(key?.alg).toBe('RS256');
    expect(typeof key?.kid).toBe('string');
    expect(typeof key?.n).toBe('string');
    expect(typeof key?.e).toBe('string');
    // Public JWK must never carry private key material.
    expect(key?.d).toBeUndefined();
  });

  it('requires no authentication', async () => {
    const res = await request(app).get('/v1/auth/.well-known/jwks.json');
    expect(res.status).not.toBe(401);
  });
});
