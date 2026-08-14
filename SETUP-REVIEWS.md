# Reviews and private moderation

The review system is included in this repository and requires no source-code placeholders or manual code edits.

## How it works

1. A visitor submits a name, private email, one-to-five-star rating, review and optional photo.
2. The Worker validates the request and stores it as `pending` in Cloudflare D1. Photos are converted to WebP and kept in a private R2 bucket.
3. The visitor receives only a neutral “review received” message. They are not told about approval or denial.
4. A private moderation email goes to `nulookautocareaustralia@gmail.com` with separate review-and-approve and review-and-deny links.
5. Either link opens a confirmation page. Email scanners cannot approve or deny because a separate POST confirmation is required.
6. Approved reviews and photos become public. Denied photos and private moderation tokens are removed.

The public API selects only `approved` records and never returns reviewer emails or moderation data.

## Cloudflare resources

`wrangler.jsonc` declares:

- `REVIEWS_DB`: Cloudflare D1
- `REVIEW_IMAGES`: private Cloudflare R2
- `IMAGES`: Cloudflare Images transformation binding
- `ASSETS`: the website files in this repository root

With Wrangler 4.45 or newer, D1 and R2 bindings without account-specific IDs are provisioned automatically during `wrangler deploy`. The Worker also runs idempotent `CREATE TABLE IF NOT EXISTS` statements before using the database, so a newly provisioned database is ready on the first request. Versioned SQL remains in `migrations/` for future maintenance.

## Email delivery

The default path uses FormSubmit's AJAX endpoint to deliver moderation details to `nulookautocareaustralia@gmail.com`, so no API key is committed to GitHub. The site's contact form already uses the same address. If FormSubmit has not seen that address before, open the one-time activation email in that mailbox; this is account verification, not a code change.

For a dedicated sender, the Worker automatically prefers Resend when both runtime variables below exist in Cloudflare:

- Secret: `RESEND_API_KEY`
- Variable: `REVIEW_FROM_EMAIL`, for example `NuLook Reviews <reviews@your-verified-domain.com>`

The sender domain must first be verified with Resend. These are optional runtime settings; the repository works with the FormSubmit fallback when they are absent.

## Optional Turnstile protection

Turnstile is optional. If enabled, configure all three runtime values together in Cloudflare:

- Variable: `TURNSTILE_SITE_KEY`
- Secret: `TURNSTILE_SECRET_KEY`
- Variable: `EXPECTED_TURNSTILE_HOSTNAME` (hostname only, without `https://`)

Leaving all three absent keeps the review form available. The Worker never trusts a browser-only check and verifies enabled Turnstile responses server-side.

## Deploy from GitHub

Use Cloudflare **Workers Builds**, not a Cloudflare Pages project:

1. Upload every file and folder in this package to the GitHub repository root.
2. In Cloudflare, open the `nulook-auto-care` Worker and connect the GitHub repository under **Settings -> Builds**.
3. Keep the root directory as `/` and the deploy command as the default `npx wrangler deploy`.
4. Push to the production branch. Cloudflare deploys the Worker, static site, D1, R2 and bindings together.
5. Attach the existing custom domain to that Worker if it is not already attached.

No migration command is required for a fresh or existing deployment because schema bootstrap is built into the Worker. `npm run db:remote` remains available for operators who prefer recorded Wrangler migrations.

## Verify after deployment

- Open `https://YOUR-DOMAIN/api/reviews`. It should return JSON such as `{"reviews":[]}`, not an HTML page or 404.
- Submit a test review. The public list remains unchanged while the review is pending.
- Open the moderation email and use the approval confirmation. Refresh the Reviews section; the approved review appears.
- If a photo was included, confirm it is private before approval and visible only after approval.

If `/api/reviews` returns 404, the domain is still serving a Pages/static project instead of this Worker. If it returns a temporary 503 on the very first request, wait a few seconds for newly provisioned bindings and retry once.

## Security and privacy notes

- Moderation links use 32-byte random one-time tokens; only SHA-256 token hashes are stored in D1.
- Moderation GET pages do not change state.
- Review photos remain in private R2 and are exposed only through status-checking Worker routes.
- Uploaded photos are limited to 5 MB and transformed to a still WebP up to 1600 by 1600 pixels.
- Rate limiting uses a server-generated random pepper stored in D1; raw IP addresses are not stored.
- A failed moderation email triggers immediate cleanup. If photo storage is temporarily unavailable, the private D1 pointer is retained and the hourly cleanup job retries it instead of orphaning the object.
- Reviewers receive no approval or denial notification.
