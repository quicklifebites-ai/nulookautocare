# NuLook Auto Care website

This repository is the complete NuLook Auto Care website: responsive static pages, nine self-hosted WebP car images, and a Cloudflare Worker that provides approved public reviews, private photo storage and email moderation.

## Repository layout

Keep this layout at the GitHub repository root. Do not upload only `index.html`.

```text
/
|-- index.html
|-- styles.css
|-- reviews.css
|-- script.js
|-- reviews.js
|-- favicon.svg
|-- assets/
|   `-- car-*.webp
|-- worker/
|   `-- index.js
|-- migrations/
|-- wrangler.jsonc
`-- package.json
```

All browser assets use portable `./...` URLs, so they work from a GitHub repository root and from a Cloudflare custom domain. The review API intentionally uses same-origin `/api/...` routes.

## Correct Cloudflare deployment

GitHub is the source repository. Cloudflare **Workers Builds** must deploy the whole repository as one Worker with Static Assets. This is not a separate GitHub Pages or Cloudflare Pages static site: those products do not execute `worker/index.js`, so `/api/reviews` would return 404.

For the existing Cloudflare Worker, connect this repository under **Settings -> Builds**. Use:

- Root directory: `/`
- Deploy command: `npx wrangler deploy` (the Cloudflare default)
- Production branch: your GitHub default branch, normally `main`

The Worker name must be `nulook-auto-care`, matching `wrangler.jsonc`. No values in the source files need to be replaced. Current Wrangler automatically provisions the D1 and R2 bindings on deployment, and the Worker creates any missing review tables on its first API request.

See `SETUP-REVIEWS.md` for the moderation workflow and optional email/spam-protection upgrades.

## Local checks

After Node.js is installed:

```powershell
npm install
npm run check
npm run dev
```

`npm run check` validates JavaScript syntax, exact path casing, required files, all WebP files and the absence of deployment placeholders.

For a static-only visual preview, serve this folder with any local HTTP server. A static preview can show the review interface but cannot execute the Cloudflare API.

## Images

The slideshow uses `assets/car-01.webp` through `assets/car-09-hyundai-i30.webp` and advances every four seconds. The added Australian-market selection includes Toyota Camry, Mazda CX-5, Ford Ranger and Hyundai i30-style everyday vehicles. All images are local; the live page has no remote image dependency. Generation details and prompts are recorded in `IMAGE-PROMPTS.md`.

## Contact email

Website enquiries and review moderation go to `nulookautocareaustralia@gmail.com`. The contact form and the zero-secret moderation fallback use FormSubmit. FormSubmit may send a one-time activation message to that mailbox if the address has not already been activated.
