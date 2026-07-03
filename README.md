# ridgits-api

Next.js API on Vercel for **Ridgits iOS** (and future web migration). Replaces Firebase Cloud Function callables for the mobile app.

Firebase **Auth + Firestore** stay on project `ridgits-24f2d`.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/auth/validate-signup` | Pre-signup check: disposable email + 18+ birth year (unauthenticated, IP rate-limited) |
| GET | `/api/account/access` | Nearby subscription access |
| POST | `/api/iap/link-purchase` | Link App Store purchase |
| POST | `/api/webhooks/app-store` | App Store Server Notifications v2 |
| POST | `/api/matches/nearby` | Find nearby matches |
| POST | `/api/matches/nationwide` | Top nationwide matches |
| POST | `/api/messaging/start` | Start pending conversation |
| POST | `/api/messaging/approve` | Approve conversation |
| POST | `/api/messaging/send` | Send message |
| POST | `/api/messaging/read` | Mark conversation read |
| POST | `/api/notifications/register-device` | Register FCM device token |
| DELETE | `/api/notifications/register-device` | Remove device token |
| GET | `/api/notifications/preferences` | Fetch push preferences |
| PATCH | `/api/notifications/preferences` | Update push preferences |
| POST | `/api/notifications/preferences` | Record notification open |
| GET/POST | `/api/notifications/cron` | Hourly engagement cron (`CRON_SECRET`) |
| POST | `/api/pokes/send` | Send poke + push |
| POST | `/api/pokes/seen` | Mark poke seen |
| POST | `/api/pokes/unpoke` | Remove poke |

All authenticated routes use `Authorization: Bearer <Firebase ID token>`.

Push delivery uses `firebase-admin/messaging`. See `Ridgits-iOS/NOTIFICATIONS_SETUP.md` for APNs/FCM manual setup.

## Setup

```bash
cp .env.example .env.local
npm install
npm run dev
```

## Deploy (Vercel)

1. Push this repo to GitHub (`lkishfy/ridgits-api`).
2. Import into Vercel.
3. Set env vars from `.env.example`.
4. Point App Store Connect notifications to `https://ridgits-api.vercel.app/api/webhooks/app-store`.
5. Set iOS `Secrets.plist` → `ridgitsApiBaseURL`.

## iOS integration

`RidgitsAPIClient` handles all HTTP backend calls. Firestore realtime listeners remain on the Firebase SDK for conversations/messages.

## Trust & safety

See [`TRUST_SAFETY.md`](./TRUST_SAFETY.md) for disposable-email blocking, email-verification
gating, phone/VOIP verification prep, birth-year 18+ enforcement, signup rate limiting
(+ recommended Vercel Firewall rules), the 24h new-account cooldown, profile-photo
validation, and the paid-subscription requirement for pokes/messaging.
