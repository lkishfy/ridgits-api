# Trust & Safety

This document covers the trust & safety controls implemented in `ridgits-api`, why the
API (not the client) is the source of truth, and what's left as documented-but-not-fully-wired
(phone verification, Vercel Firewall rules).

All logic lives under `src/lib/trust-safety/`:

| File | Responsibility |
|---|---|
| `disposable-email.ts` | Blocks throwaway/temp-mail signups |
| `email-verification.ts` | Authoritative `emailVerified` checks (Admin Auth, not client fields) |
| `rate-limit.ts` | Firestore-backed fixed-window rate limiting + IP helpers |
| `account-age.ts` | 24h+ cooldown before first poke/message |
| `age.ts` | 18+ birth-year validation |
| `profile-photo.ts` | Real-photo URL validation + optional NSFW moderation hook |
| `phone-safety.ts` | Phone hashing, VOIP lookup, device-fingerprint abuse flagging |
| `subscription-gate.ts` | Paid-subscription requirement for pokes/messaging |

## 1. Disposable email blocking

`disposable-email.ts` uses the community-maintained [`disposable-email-domains`](https://www.npmjs.com/package/disposable-email-domains)
npm package (~120k domains + a wildcard-subdomain list), instead of the old ~10-domain
static list. Keep it current with `npm update disposable-email-domains`.

- `RIDGITS_EXTRA_DISPOSABLE_DOMAINS` — comma-separated domains to block in addition to the list.
- `RIDGITS_ALLOWED_EMAIL_DOMAINS` — comma-separated allowlist for rare false positives.

Enforced via **`POST /api/auth/validate-signup`** — an unauthenticated, IP-rate-limited
endpoint the client calls *before* creating a Firebase Auth account (email/password or
OAuth) so a modified/patched client can't bypass the check by skipping client-side
validation. It also validates birth year (18+) when provided (`email` and `birthYear` are
each optional, so the same route covers pre-signup checks and post-OAuth birth-year
confirmation).

- **iOS** calls it from `AuthManager.createAccountWithEmail` (pre-signup) and
  `AuthManager.completeBirthYear` (post-OAuth birth-year confirmation) via
  `RidgitsAPIClient.validateSignup`, in addition to a curated client-side disposable-domain
  list (`RidgitsDisposableEmail`) for instant feedback before the network round-trip.
- **Web** does not currently call `ridgits-api` at all (it talks to Firebase directly, with
  no established CORS/base-URL wiring to this API), so it only has the client-side curated
  list (`utils/disposableEmail.js`) plus the Firestore-rules-enforced 18+ check below — a
  patched web client *could* theoretically bypass the disposable-email list (client-side
  JS can always be edited), which the iOS app cannot for the same check. Wiring the web
  app to call `validate-signup` too would close that gap; it's a small addition (a `fetch`
  to the API's public URL) once CORS is configured on `ridgits-api` for the web origin.

## 2. Verified email required for community actions

`email-verification.ts` checks the Firebase ID token's `email_verified` claim
(`RidgitsAuthContext.emailVerified`, set in `ridgits-auth.ts`). This claim is set by
Firebase Auth when the ID token is minted and verified server-side via Admin SDK
signature checks — it can't be spoofed by the client. OAuth (Google/Apple) sign-ins get
`emailVerified = true` automatically; password accounts must click the verification link
(already sent from `createAccountWithEmail` on iOS / `sendEmailVerification` on web).

Enforced server-side in:
- `pokes/handlers.ts` → `sendPoke` (403 `EMAIL_NOT_VERIFIED`)
- `messaging/handlers.ts` → `ensureMessagingAllowed` (used by start/approve/send) (403 `EMAIL_NOT_VERIFIED`)
- `matching/nearby.ts` → candidates with an unverified email are filtered out of nearby
  results even if `visibleInCommunity` is `true`, via a batched `auth.getUsers()` lookup
  (`getVerifiedEmailMap`).

**iOS**: `AuthManager.emailVerified` mirrors `Auth.auth().currentUser.isEmailVerified`
(Firebase Auth's own record, not a spoofable Firestore field). `ProfileSettingsView` shows
a "Verify your email" card with a resend button (`AuthManager.resendVerificationEmail`)
for password accounts that haven't verified yet; Google/Apple accounts never see it since
they're verified automatically. Poke/message call sites also surface the server's
`EMAIL_NOT_VERIFIED` message directly (via `RidgitsError.serverCoded`) if a user tries the
action before verifying.

## 3. Phone verification prep (not fully wired)

There is no phone-auth UI yet. `phone-safety.ts` establishes the structure so it can be
turned on without a redesign:

1. When a phone number is collected, call `lookupPhoneIntelligence(phone)` (Twilio Lookup
   v2 `line_type_intelligence`) **before** sending an OTP, and reject/flag `voip` numbers
   per product policy. No-ops safely if `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` aren't set.
2. After OTP verification, call `findExistingPhoneOwner(phone)` to block re-use, then
   `claimPhoneForUser(uid, phone)`, which stores only a **salted SHA-256 hash**
   (`RIDGITS_PHONE_HASH_SALT`) in `phoneHashes/{hash}` and `users/{uid}.phoneHash` — the
   raw phone number is never persisted by this helper.

**Device fingerprinting is live today**, reusing the `deviceId` iOS already sends to
`/api/notifications/register-device`. `recordDeviceFingerprint(uid, deviceId)` maintains
`deviceFingerprints/{deviceId}.uids[]`; once a single device has registered
`RIDGITS_DEVICE_MULTI_ACCOUNT_THRESHOLD` (default 3) distinct accounts, it adds
`trustSafetyFlags: ['multi_account_device']` to the user doc and writes an entry to
`trustSafetyFlags` for manual review. This is a signal for review, not an automatic ban.

## 4. Birth year + 18+ rejection

- **iOS**: `EmailAuthSheet` already collects birth year for password signups.
  `AuthManager`/`ContentView` now also collect it for Google/Apple sign-in via a
  post-auth "confirm your birth year" step when missing on the user doc (new *and*
  legacy OAuth accounts).
- **Web**: `Login.jsx`/`PersonalityQuiz.jsx` already collect birth year for both
  email and Google sign-up.
- **Server-side 18+ rejection**: `age.ts` exports `requireAdultBirthYear`, used by
  `POST /api/auth/validate-signup`. Because profile writes currently go straight from the
  client to Firestore (no `ridgits-api` profile-save route exists yet), the   same 18+ rule
  is mirrored at the Firestore Security Rules layer — see
  `Ridgits/ridgits/firestore.rules` (`hasValidAdultBirthYear`) on `users/{userId}` — which is
  genuinely server-enforced (Firestore rules run on Google's infrastructure, not the
  client) and can't be bypassed by a patched app binary. If/when a `ridgits-api`
  profile-save endpoint is added, call `requireAdultBirthYear` there too.

## 5. Signup-sensitive rate limiting

`rate-limit.ts` implements a Firestore-backed fixed-window limiter
(`rateLimits/{bucket}__{identifier}`). Firestore (not in-memory) was chosen because Vercel
functions are stateless and horizontally scaled — an in-memory counter resets on every
cold start and isn't shared across concurrent instances, so it can't enforce a real limit.

Applied to:

| Route | Buckets | Limit |
|---|---|---|
| `POST /api/auth/validate-signup` | IP | 20 / hour |
| `POST /api/pokes/send` | uid, IP | 60 / hour, 120 / hour |
| `POST /api/messaging/start` | uid, IP | 20 / hour, 40 / hour |
| `POST /api/messaging/send` | uid, IP | 120 / hour, 240 / hour |
| `POST /api/notifications/register-device` | IP | 30 / hour |

All 429 responses include `Retry-After` (seconds) and `{ "code": "RATE_LIMITED" }`.

### Vercel Firewall (recommended, dashboard-configured — not code)

For coarse IP/ASN/bot protection *before* a request even reaches these routes, configure
[Vercel Firewall](https://vercel.com/docs/security/vercel-firewall) rules on the project:

- Rate limit `POST /api/auth/validate-signup`, `/api/pokes/send`, `/api/messaging/*` by IP
  (e.g. 100 req / 10 min) as a first line of defense in front of the app-level limits above.
- Block known hosting/VPN/datacenter ASNs from signup-sensitive routes if fake-account
  abuse concentrates there (Vercel Firewall exposes ASN + IP reputation rules).
- Enable "Attack Challenge Mode" during a detected signup spike.
- Optionally geo-block countries outside your target market for signup routes only.

These are dashboard/`vercel.json` firewall rules, not something this repo can encode in
TypeScript — see the Vercel dashboard's Firewall tab for the project.

## 6. Cooldown before first poke/message (24h)

`account-age.ts` reads `accountCreationDate`/`createdAt` off the `users/{uid}` doc (both
iOS's `AuthManager.saveUserProfile` and the web `Login.jsx` already set one of these on
signup) and blocks **new conversations and pokes** — not continuing an existing active
conversation — until `RIDGITS_MIN_ACCOUNT_AGE_HOURS` (default 24) have elapsed. Legacy
accounts with no creation date on file are not penalized. The error message includes the
exact time remaining, e.g. *"Your account needs to be active for 24 hours before you can
do this. Time remaining: 3 hours."* (`code: "ACCOUNT_TOO_NEW"`).

## 7. Real profile photo required

`profile-photo.ts` → `validateProfilePhotoUrl` rejects empty URLs, `data:` URIs, and
non-`https` URLs. Set `RIDGITS_PHOTO_HEAD_CHECK=true` to additionally HEAD-request the URL
and confirm it resolves with an `image/*` content type (best-effort; network failures
don't hard-block a save).

`moderateProfilePhoto(url)` is a placeholder NSFW/stock-photo moderation hook. It's a
pass-through no-op unless `RIDGITS_MODERATION_PROVIDER=sightengine` plus
`SIGHTENGINE_API_USER`/`SIGHTENGINE_API_SECRET` are set, in which case it calls
[Sightengine](https://sightengine.com/)'s nudity/offensive-content models. Swap in AWS
Rekognition or Google Vision SafeSearch by adding another branch to the same function.

Enforced in `pokes/handlers.ts` and `messaging/handlers.ts` (structural checks only by
default — `moderateProfilePhoto` is available to call from a profile-save flow once one
exists in the API).

## 8. Paid subscription required to poke/message

`subscription-gate.ts` → `requireActiveSubscription` reuses the existing
`getNearbyAccess`/`hasActiveSubscriptionAccess` logic in `ridgits-subscription.ts` (Ridgits+,
Premium, Ultra, Stripe or App Store, plus the `RIDGITS_BYPASS_EMAILS` QA bypass). Free
users can still browse/match — **only** `sendPoke` and the messaging handlers
(`startConversation`, `approveConversation`, `sendMessage`) are gated, returning
`402 { code: "SUBSCRIPTION_REQUIRED" }`. iOS catches this code
(`RidgitsError.serverCoded`) in `MatchesViewModel.sendPoke`, `MessagingViewModel.approve`/
`sendMessage`, and the "message request" compose sheet, and presents
`SubscriptionPaywallView` instead of a generic error toast.

## 9. Does Apple help with any of this by default?

Short answer: **partially, and not with the hardest parts.**

What Apple *does* provide:
- **Sign in with Apple** gives every user a verified email (or a private relay address)
  out of the box — no separate email-verification step needed for Apple sign-ins.
- **App Store age ratings** (e.g. 17+) gate *installing* the app for users whose Apple ID
  birthdate/Screen Time settings say they're younger, but this is a blunt, self-reported,
  device-level control — it does not verify the actual person's age at signup and is
  trivially bypassed by a shared/family device or a fake Apple ID birthdate.
- **DeviceCheck / App Attest (via Firebase App Check)** can prove a request came from a
  genuine, unmodified copy of your app on real Apple hardware — this helps against
  scripted/bot signups and API abuse, but says nothing about the *person* behind the device.
- **StoreKit / App Store Connect** enforces subscription billing integrity, but has no
  concept of "dating intent" or content policy for your app's own messaging.

What Apple explicitly does **not** provide:
- No built-in prostitution/escort/soliciting filtering — that's entirely the app's
  responsibility (profanity/keyword filters, photo moderation, human review, user reports).
- No verification that a user is who they claim, that photos are of the account holder, or
  that the account isn't a bot/scraper — App Review checks the *app*, not individual users
  or their behavior.
- No phone-number/VOIP verification, no dating-specific background checks, and no
  duplicate-account detection across devices — this is exactly the gap `phone-safety.ts`
  and `deviceFingerprints` are meant to close.
- No enforcement of minimum account age before messaging, subscription-gating messaging,
  or rate-limiting abusive signups — all app-level product decisions, which is what this
  PR implements.

In short: Apple gives you identity plumbing (Sign in with Apple, App Attest) and a coarse
age-rating gate at install time, but all of the dating-app-specific trust & safety
surface — verified email for messaging, cooldowns, subscription gating, phone/VOIP
verification, fake-account detection, and content moderation — has to be built by the app,
which is what this document covers.
