/**
 * Express `Request` augmentation — attaches decoded JWT claims and the
 * per-request correlation ID set by src/middleware/requestId.ts.
 */

import type { JwtAccessTokenClaims } from './index.js';

declare global {
  namespace Express {
    interface Request {
      auth?: JwtAccessTokenClaims;
      requestId: string;
    }
  }
}

export {};
