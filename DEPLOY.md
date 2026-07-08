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
2. Create a **Verification flow** (Identity → Verification flows) with **Document + selfie + phone OTP** enabled.
3. Copy the flow ID (`vf_...`) into Vercel as `STRIPE_IDENTITY_VERIFICATION_FLOW_ID`.
4. Configure return URL to `https://ridgits.com/identity/complete` (Stripe requires https; that page redirects to `ridgits://identity/complete` in the iOS app).
5. Add webhook endpoint → `https://ridgits-api.vercel.app/api/webhooks/stripe-identity`
6. Subscribe to: `identity.verification_session.verified`, `identity.verification_session.requires_input`, `identity.verification_session.canceled`
7. Set Vercel env vars:

```
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_IDENTITY_RETURN_URL=https://ridgits.com/identity/complete
STRIPE_IDENTITY_VERIFICATION_FLOW_ID=vf_...
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
RIDGITS_IDENTITY_FACE_MATCH_THRESHOLD=0.90
STRIPE_IDENTITY_RESTRICTED_KEY=rk_...
# Comma-separated account emails for users you manually verified in Stripe Dashboard
# (bypasses automated profile photo ↔ ID selfie match).
RIDGITS_MANUAL_PHOTO_VERIFIED_EMAILS=
# Optional: keep Sightengine for NSFW profile moderation only.
SIGHTENGINE_API_USER=...
SIGHTENGINE_API_SECRET=...
RIDGITS_MODERATION_PROVIDER=sightengine
```

Face match uses **Amazon Rekognition CompareFaces** (`AWS_*` vars above). Sightengine is optional and only used when `RIDGITS_MODERATION_PROVIDER=sightengine` for NSFW/content moderation.

### AWS IAM for Rekognition

Create an IAM user (or role) used only by `ridgits-api` with this policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["rekognition:CompareFaces"],
      "Resource": "*"
    }
  ]
}
```

Generate access keys for that user and add them to Vercel as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Use the same region you enabled Rekognition in (e.g. `us-east-1`).

### Profile photo before identity verification

Users must upload a profile photo **before** starting Stripe Identity (`PROFILE_PHOTO_REQUIRED` if missing). After ID verification, the one-time face match must run within Stripe's **48-hour** selfie access window (or use the manual allowlist below).

### Manual photo verification allowlist

When automated face match fails (e.g. user waited >48 hours), compare their profile photo to the ID selfie in the Stripe Identity Dashboard, then add their **account email** to `RIDGITS_MANUAL_PHOTO_VERIFIED_EMAILS` in Vercel (comma-separated). Redeploy is required. The user can message immediately; tapping "Retry photo verification" will persist `verified` to Firestore.

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
