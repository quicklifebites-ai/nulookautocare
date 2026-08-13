# NuLook Auto Care website

A lightweight, responsive static website built with HTML, CSS and JavaScript. No frameworks, external fonts or remote image dependencies are used.

## Run locally

Open `index.html` directly in a browser, or serve the folder with any static server. For example:

```powershell
cd C:\Users\sahil\Documents\Codex\2026-08-14\ai\work\nulook-site
python -m http.server 8080
```

Then visit `http://localhost:8080`.

## Image files

The hero slideshow expects these local files:

- `assets/car-01.webp`
- `assets/car-02.webp`
- `assets/car-03.webp`
- `assets/car-04.webp`
- `assets/car-05.webp`

For best results, export landscape WebP images at 2000 × 1200 pixels or larger, keep each file under roughly 500 KB, and leave some uncluttered space on the left for the hero copy. The slideshow advances every four seconds.

The included images were created for this rebuild with the built-in image-generation workflow. See `IMAGE-PROMPTS.md` for the final prompt set.

## Contact form

The form submits to FormSubmit using `nulookautocareaustralia@gmail.com`. FormSubmit may send a one-time activation email the first time the form is used. Visitors can also use the visible direct email link if form submission is unavailable.

## Reviews and moderation

The site now includes a public approved-reviews section, an accessible 1–5 star review form, and optional customer photo upload. Pending reviews are never returned by the public API. The owner receives private approve/deny links at `nulookautocareaustralia@gmail.com`, with a confirmation step before either decision is applied.

See `SETUP-REVIEWS.md` to connect Cloudflare D1, private R2 storage, Cloudflare Images, and the moderation email service. The static localhost preview cannot persist or moderate real reviews until this backend setup is completed.
