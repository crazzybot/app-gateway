import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asMockedDb, createChainableResult } from './helpers/mockDb.js';

vi.mock('@/db/client.js', () => ({
  db: {
    insert: vi.fn(() => createChainableResult([])),
  },
}));

const db = asMockedDb((await import('@/db/client.js')).db);
const { writeAuditEvent } = await import('@/services/audit.service.js');
const { logger } = await import('@/config/logger.js');

beforeEach(() => {
  vi.mocked(db.insert).mockReset().mockReturnValue(createChainableResult([]));
});

describe('writeAuditEvent', () => {
  it('inserts a row with the given event_type and outcome', async () => {
    await writeAuditEvent({
      event_type: 'auth.login',
      user_id: 'u-1',
      outcome: 'success',
    });

    expect(db.insert).toHaveBeenCalledOnce();
  });

  it('defaults metadata to {} and nullable fields to null', async () => {
    const insertMock = vi.mocked(db.insert);
    const builder = createChainableResult([]);
    insertMock.mockReturnValue(builder);

    await writeAuditEvent({ event_type: 'auth.login_failed', outcome: 'failure' });

    const [values] = builder.values.mock.calls[0] as [Record<string, unknown>];
    expect(values['metadata']).toEqual({});
    expect(values['userId']).toBeNull();
    expect(values['failureReason']).toBeNull();
  });

  it('never throws on a persistence failure — logs and returns instead', async () => {
    vi.mocked(db.insert).mockImplementation(() => {
      throw new Error('connection refused');
    });
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    await expect(
      writeAuditEvent({ event_type: 'auth.login', outcome: 'success' }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to write audit log entry',
      expect.objectContaining({ eventType: 'auth.login' }),
    );
  });
});
