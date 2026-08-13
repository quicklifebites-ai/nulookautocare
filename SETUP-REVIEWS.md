# Activate reviews and private email moderation

The Reviews interface is complete. The database, private photo storage, and moderation email service must be connected before real reviews can be accepted. The local static preview intentionally shows a temporary-unavailable state because a browser alone cannot securely moderate or persist reviews.

This package uses one Cloudflare Worker with Static Assets, D1 for reviews, a private R2 bucket for customer photos, Cloudflare Images to resize/re-encode uploads, optional Turnstile protection, and Resend for moderation email.

## What the workflow does

1. A visitor submits their name, private email, 1–5 stars, review, and optional JPG/PNG/WebP/HEIC photo.
2. The backend validates the submission, removes photo metadata by converting it to WebP, and saves everything as `pending`.
3. The visitor sees only a neutral “review received” message. There is no public status page and no approval/denial email to the visitor.
4. A moderation email is sent to `nulookautocareaustralia@gmail.com` with the review and two private links.
5. An email link opens a confirmation page where you can inspect the complete review and its protected photo, if supplied. It does not change anything on its own.
6. Pressing the confirmation button approves or denies the review. Only approved reviews and photos become public. A denied photo is deleted.

Someone may naturally notice later that their approved review is public, but the website never directly discloses the moderation decision to them.

## Accounts and values required

- Cloudflare account
- A production domain or Workers URL
- D1 database named `nulook-reviews`
- Private R2 bucket named `nulook-review-images`
- Resend account and API key
- A sender domain verified in Resend, used for `REVIEW_FROM_EMAIL`
- Optional Cloudflare Turnstile site key and secret
- A long random `MODERATION_SECRET`

Do not put secrets into `wrangler.jsonc`, source control, or chat.

## Setup commands

Install the deployment tool:

```powershell
npm install
npx wrangler login
```

Create resources:

```powershell
npx wrangler d1 create nulook-reviews
npx wrangler r2 bucket create nulook-review-images
```

Copy the `database_id` returned by the first command into `wrangler.jsonc`, replacing `REPLACE_WITH_D1_DATABASE_ID`.

Also replace `https://YOUR_WEBSITE_DOMAIN` with the exact public website origin, including `https://` and no trailing path.

Apply the schema:

```powershell
npm run db:remote
```

In Resend, verify the company’s sending domain. Replace `reviews@YOUR_VERIFIED_DOMAIN` in `wrangler.jsonc` with a sender at that domain. The destination is already fixed to `nulookautocareaustralia@gmail.com`.

Store secrets interactively:

```powershell
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put MODERATION_SECRET
```

Generate `MODERATION_SECRET` with a password manager or at least 32 random bytes. Do not reuse a password.

Optional but recommended for spam protection: create a Turnstile widget for the production hostname. Put its public site key in `TURNSTILE_SITE_KEY`, put that hostname (without `https://`) in `EXPECTED_TURNSTILE_HOSTNAME`, then store its server secret:

```powershell
npx wrangler secret put TURNSTILE_SECRET_KEY
```

The website automatically renders the widget when a site key is present, and the backend enforces it whenever the secret exists. Add both values together; setting only one will prevent submissions.

Deploy:

```powershell
npm run check
npm run deploy
```

## Important operating notes

- The R2 bucket must remain private; do not enable its public `r2.dev` address.
- Moderation links expire after 30 days.
- The first confirmed approve/deny decision is final.
- Approved images are served only through a status-checking endpoint.
- Uploaded images are limited to 5 MB and converted to a still WebP up to 1600×1600.
- Five accepted submissions per hashed IP are allowed per 24-hour window.
- If the moderation email cannot be delivered, the submission and any photo are removed and the visitor is asked to try again; a review is never silently stranded without an owner notification.
- Delete old pending/denied text records periodically according to your privacy policy. Denied photos are deleted immediately, and repeating the signed deny confirmation safely retries an interrupted photo cleanup.

## Local UI preview

The existing simple static server can preview all layout and modal interactions, but it cannot run D1/R2/email:

```powershell
python -m http.server 8080
```

For full local backend development after running `npm install`:

```powershell
npm run db:local
npm run dev
```

Cloudflare’s local simulation provides local D1/R2 state. Email still requires a valid Resend API key and sender configuration.
