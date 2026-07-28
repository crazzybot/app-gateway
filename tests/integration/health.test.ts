import request, { type Response } from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '@/index.js';
import { closeConnections } from './helpers/closeConnections.js';

interface HealthBody {
  status: string;
  uptime: number;
}

interface ReadyBody {
  status: string;
  checks: Record<string, 'ok' | 'error'>;
}

afterAll(async () => {
  await closeConnections();
});

describe('GET /health (FR-24)', () => {
  it('returns 200 with status and uptime, no dependency checks', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    const body = res.body as HealthBody;
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
  });
});

describe('GET /ready (FR-24, AC-29)', () => {
  it('returns 200 with per-dependency status when Postgres and Redis are healthy', async () => {
    const res: Response = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body as ReadyBody).toEqual({
      status: 'ready',
      checks: { postgres: 'ok', redis: 'ok', routes: 'ok' },
    });
  });
});
