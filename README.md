# ridgits-api

Next.js API on Vercel for **Ridgits iOS** (and future web migration). Replaces Firebase Cloud Function callables for the mobile app.

Firebase **Auth + Firestore** stay on project `ridgits-24f2d`.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/account/access` | Nearby subscription access |
| POST | `/api/iap/link-purchase` | Link App Store purchase |
| POST | `/api/webhooks/app-store` | App Store Server Notifications v2 |
| POST | `/api/matches/nearby` | Find nearby matches |
| POST | `/api/matches/nationwide` | Top nationwide matches |
| POST | `/api/messaging/start` | Start pending conversation |
| POST | `/api/messaging/approve` | Approve conversation |
| POST | `/api/messaging/send` | Send message |
| POST | `/api/messaging/read` | Mark conversation read |

All authenticated routes use `Authorization: Bearer <Firebase ID token>`.

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
