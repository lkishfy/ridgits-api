# ridgits-api deployment

Deploy to Vercel (same pattern as `geists-api`).

## 1. GitHub

```bash
cd ridgits-api
git remote add origin https://github.com/lkishfy/ridgits-api.git
git push -u origin main
```

## 2. Vercel

1. Import `lkishfy/ridgits-api` in Vercel.
2. Set production env vars:

```
FIREBASE_PROJECT_ID=ridgits-24f2d
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY=...
APP_STORE_BUNDLE_ID=com.ridgits.app
RIDGITS_BYPASS_EMAILS=
```

3. Deploy. Production URL: `https://ridgits-api.vercel.app`

Verify: `curl https://ridgits-api.vercel.app/api/health`

## 3. App Store Connect

App Store Server Notifications v2 →  
`https://ridgits-api.vercel.app/api/webhooks/app-store`

## 4. Stripe Identity (iOS verification gate)

1. Enable **Stripe Identity** in the Stripe Dashboard.
2. Configure verification flow type **Document** (government ID + selfie). Enable **Verify phone** (OTP). Leave **Verify email** unchecked unless you want both. Set return URL to `https://ridgits.com/identity/complete` (Stripe requires https; that page redirects to `ridgits://identity/complete` in the iOS app).
3. Add webhook endpoint → `https://ridgits-api.vercel.app/api/webhooks/stripe-identity`
4. Subscribe to: `identity.verification_session.verified`, `identity.verification_session.requires_input`, `identity.verification_session.canceled`
5. Set Vercel env vars:

```
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_IDENTITY_RETURN_URL=https://ridgits.com/identity/complete
SIGHTENGINE_API_USER=...
SIGHTENGINE_API_SECRET=...
RIDGITS_IDENTITY_FACE_MATCH_THRESHOLD=0.90
```

Face match uses Sightengine `face-compare` (same credentials as optional profile moderation).

## 5. Ridgits iOS

`Ridgits/Secrets.plist`:

```xml
<key>ridgitsApiBaseURL</key>
<string>https://ridgits-api.vercel.app</string>
```

All server logic (matching, messaging, IAP) goes through this URL. Firebase is used only for Auth + Firestore realtime on iOS today.

## Future: Supabase

When migrating off Firestore:

1. Add Supabase client to `ridgits-api` (Postgres + RLS).
2. Dual-write or one-time migration script from Firestore collections: `users`, `publicProfiles`, `quizProgress`, `conversations`, `messages`.
3. Swap iOS Firestore listeners for Supabase Realtime or polling via API.
4. Remove Firebase Admin from Vercel once cutover is complete.

No iOS API URL change required — the app keeps calling `ridgits-api`; only the backend data layer changes.
