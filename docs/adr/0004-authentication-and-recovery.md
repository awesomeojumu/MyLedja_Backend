# ADR-0004: Email and password with rotating refresh tokens; passkeys and MFA follow (DEC-03)

- Status: Accepted
- Date: 2026-10-16
- Story: MYL-004 (built in MYL-005)
- Spec: §17.1, §17.2, §17.4, F-001, FR-ONB-01, DEC-03

## Context

Authentication sets the account-takeover risk for an app that holds a person's whole financial picture. The spec requires:

- a proven approach with no custom cryptography, and a vetted password hash such as Argon2id;
- a verified email or phone;
- short-lived access tokens;
- refresh-token rotation or replay detection, a session inventory, and revocation including logout from all devices;
- rate limits on login, verification and recovery;
- recovery responses that never reveal whether an account exists, and recovery never weaker than primary sign-in;
- a roadmap toward passkeys and MFA.

MYL-005 must pass register → verify → login → refresh → logout end to end, and a revoked refresh token must never be reusable (TC-17).

## Options

**Who runs identity**

| Option | For | Against |
|---|---|---|
| **A. In-house `auth` module on vetted libraries** (`argon2`, `jose` or `@nestjs/jwt`) | Full control of the flows, audit and rate limits. No per-user vendor cost. Data stays in our own MongoDB. Matches the module plan (§14). | We own the session logic and must test it thoroughly. |
| B. Managed identity provider (Auth0, Clerk, Firebase Auth, Cognito) | Passkeys, MFA and breach detection come ready-made. | Per-user cost at scale. Vendor lock-in. Nigerian data-residency questions (DEC-07). Offline-first token handling still has to be built. |

**First sign-in method**

| Option | For | Against |
|---|---|---|
| **Email + password, email code verification** | Cheap, reliable and universal. | Password risk, mitigated by Argon2id, rate limits, and passkeys later. |
| Phone + SMS code | Familiar in Nigeria. | SMS cost, delivery gaps, and SIM-swap account takeover. |
| Passkeys only | The strongest option. | Device and OS support is uneven across the Android range we target. Recovery is harder. |

## Decision

**Option A, email and password first.**

- **Registration:** email + password. Passwords are hashed with **Argon2id** using a maintained library and OWASP-recommended parameters. They must be at least 10 characters and are checked against a breached-password list.
- **Verification:** a 6-digit email code that is single-use, expires in 10 minutes and is stored only as a hash. Five wrong attempts burn the code. Financial data can only be created after verification.
- **Access token:** a signed JWT that lives **15 minutes**. It carries only `sub` and `sid` (the session ID). Workspace roles are not in the token; they are resolved on the server for every request (ADR-0005).
- **Refresh token:** an opaque 256-bit random value, stored only as a SHA-256 hash, and **rotated on every use**. Each session is a token family. Presenting a token that is already used or revoked **revokes the whole family** and records a security event (TC-17). Refresh tokens expire after 30 days idle and 90 days absolute.
- **Sessions:** a `sessions` inventory with device label, creation time and last seen. Users can revoke one session or all of them. Logout revokes the current family.
- **Recovery:** a reset code sent by email, single-use, valid for 15 minutes and stored as a hash. Recovery endpoints always return the same neutral response and take similar time. A successful reset revokes every session and sends a notification.
- **Rate limits:** per IP and per account on login, verification, resend and recovery. After repeated failures, backoff kicks in. There is no permanent lockout, because an attacker could use one to lock a user out.
- **Mobile:** tokens live in OS secure storage (`expo-secure-store`). Biometric unlock opens the app locally only and never replaces server authentication (§17.2).
- **Later:** passkeys (WebAuthn), TOTP MFA and step-up re-authentication (§17.4) get their own story. Recovery must then become at least as strong as the strongest enabled method.

## Consequences

- We own security-critical code. It needs threat-model review, plus tests for rotation, reuse detection, neutral recovery and rate limits before launch.
- An email delivery provider becomes a launch dependency (DEC-07).
- Phone and SMS sign-in is not in the first release. It can be added as a second verified method later.
- If passkeys or MFA effort outgrows the team, moving to a managed provider (Option B) is still possible, because the API exposes our own session contract rather than a vendor's.
