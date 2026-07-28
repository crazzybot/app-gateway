# Dev/test signing keys — NEVER use in production

`private.pem` / `public.pem` and `previous-public.pem` are throwaway 2048-bit RSA
keypairs generated for local development and the automated test suite only
(`.env.example` points `JWT_PRIVATE_KEY_PATH`/`JWT_PUBLIC_KEY_PATH` at them, and
`previous-public.pem` exercises the two-`kid` JWKS rotation case in
`tests/integration/jwks.test.ts`).

Production deployments MUST override `JWT_PRIVATE_KEY_PATH`, `JWT_PUBLIC_KEY_PATH`,
`JWT_KID`, and (if rotating) `JWT_PREVIOUS_KID`/`JWT_PREVIOUS_PUBLIC_KEY_PATH` with
paths to real, KMS- or secret-manager-provisioned key material. These files carry
no secrecy guarantees — they are committed to version control.
