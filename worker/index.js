const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REVIEW_LENGTH = 1200;
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/reviews" && request.method === "GET") {
        return listApprovedReviews(env);
      }

      if (url.pathname === "/api/reviews" && request.method === "POST") {
        return submitReview(request, env, url);
      }

      if (url.pathname.startsWith("/api/review-images/") && request.method === "GET") {
        return serveApprovedImage(env, decodeURIComponent(url.pathname.slice(19)));
      }

      if (url.pathname === "/api/moderation-photo" && request.method === "GET") {
        return serveModerationImage(env, url);
      }

      if (url.pathname === "/review-moderate" && request.method === "GET") {
        return moderationConfirmation(env, url);
      }

      if (url.pathname === "/review-moderate" && request.method === "POST") {
        return moderateReview(request, env);
      }

      if (url.pathname.startsWith("/api/")) {
        return json({ error: "Not found." }, 404);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error("Review worker error", error);
      if (url.pathname === "/review-moderate") {
        return moderationPage("We could not process that review link.", "Please return to the moderation email and try again.", false, 500);
      }
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
  },
};

async function listApprovedReviews(env) {
  if (!env.REVIEWS_DB) return json({ error: "Reviews are not configured yet." }, 503);
  const result = await env.REVIEWS_DB.prepare(
    `SELECT id, display_name, rating, review_text, image_key, approved_at
     FROM reviews
     WHERE status = 'approved'
     ORDER BY approved_at DESC
     LIMIT 50`,
  ).all();

  const reviews = (result.results || []).map((row) => ({
    id: row.id,
    name: row.display_name,
    rating: Number(row.rating),
    review: row.review_text,
    photoUrl: row.image_key ? `/api/review-images/${encodeURIComponent(row.id)}` : null,
    approvedAt: row.approved_at,
  }));

  return new Response(JSON.stringify({ reviews, turnstileSiteKey: env.TURNSTILE_SITE_KEY || null }), {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      "cache-control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}

async function submitReview(request, env, url) {
  if (!hasSubmissionBindings(env)) {
    return json({ error: "Reviews are not configured yet." }, 503);
  }

  if (!/^multipart\/form-data(?:;|$)/i.test(request.headers.get("content-type") || "")) {
    return json({ error: "This submission format is not supported." }, 415);
  }

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_IMAGE_BYTES + 100_000) {
    return json({ error: "That upload is too large. Please use an image under 5 MB." }, 413);
  }

  const origin = request.headers.get("origin");
  const publicOrigin = configuredPublicOrigin(env, url.origin);
  if (!publicOrigin || !origin || origin !== publicOrigin || url.origin !== publicOrigin) {
    return json({ error: "This submission could not be verified." }, 403);
  }

  const data = await request.formData();
  const honeypot = clean(data.get("website"));
  if (honeypot) return json({ ok: true, message: "Thank you. Your review has been received." }, 202);

  if (env.TURNSTILE_SECRET_KEY) {
    const token = clean(data.get("cf-turnstile-response"));
    const verified = await verifyTurnstile(token, request.headers.get("CF-Connecting-IP"), env.TURNSTILE_SECRET_KEY, env.EXPECTED_TURNSTILE_HOSTNAME);
    if (!verified) return json({ error: "Please complete the verification and try again." }, 400);
  }

  const name = clean(data.get("name")).replace(/\s+/g, " ");
  const email = clean(data.get("email")).toLowerCase();
  const reviewText = clean(data.get("review"));
  const ratingValue = clean(data.get("rating"));
  const rating = /^[1-5]$/.test(ratingValue) ? Number(ratingValue) : Number.NaN;
  const image = data.get("photo");

  if (name.length < 2 || name.length > 80) return json({ error: "Please enter a valid name." }, 400);
  if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(name)) return json({ error: "Please enter a valid name." }, 400);
  if (!isEmail(email) || email.length > 254) return json({ error: "Please enter a valid email address." }, 400);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return json({ error: "Please choose a star rating." }, 400);
  if (reviewText.length < 10 || reviewText.length > MAX_REVIEW_LENGTH) {
    return json({ error: `Please write between 10 and ${MAX_REVIEW_LENGTH} characters.` }, 400);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reviewText)) {
    return json({ error: "Please remove unsupported characters from your review." }, 400);
  }

  const hasImage = isUploadedFile(image);
  let imageKey = null;
  if (hasImage) {
    if (!isAcceptedImage(image) || image.size > MAX_IMAGE_BYTES) {
      return json({ error: "Please use a JPG, PNG, WebP or HEIC image under 5 MB." }, 400);
    }
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const currentBucket = createdAt.slice(0, 10);
  const previousBucket = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const ipHash = await hashIp(ip, env.MODERATION_SECRET, currentBucket);
  const previousIpHash = await hashIp(ip, env.MODERATION_SECRET, previousBucket);

  const recent = await env.REVIEWS_DB.prepare(
    "SELECT COUNT(*) AS count FROM reviews WHERE (ip_hash = ?1 OR ip_hash = ?2) AND created_at >= ?3",
  ).bind(ipHash, previousIpHash, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()).first();
  if (Number(recent?.count || 0) >= 5) {
    return json({ error: "Too many reviews were submitted recently. Please try again tomorrow." }, 429);
  }

  if (hasImage) {
    let transformed;
    try {
      transformed = (
        await env.IMAGES.input(image.stream())
          .transform({ width: 1600, height: 1600, fit: "scale-down" })
          .output({ format: "image/webp", quality: 82, anim: false })
      ).response();
    } catch (_error) {
      return json({ error: "That image could not be processed. Please try another." }, 400);
    }
    if (!transformed.ok || !transformed.body) return json({ error: "That image could not be processed. Please try another." }, 400);
    imageKey = `pending/${id}/review-photo.webp`;
    try {
      await env.REVIEW_IMAGES.put(imageKey, transformed.body, {
        httpMetadata: { contentType: "image/webp", cacheControl: "private, no-store" },
        customMetadata: { reviewId: id },
      });
    } catch (_error) {
      return json({ error: "That image could not be stored. Please try again." }, 500);
    }
  }

  try {
    await env.REVIEWS_DB.prepare(
      `INSERT INTO reviews
        (id, display_name, email, rating, review_text, image_key, status, created_at, ip_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8)`,
    ).bind(
      id,
      name,
      email,
      rating,
      reviewText,
      imageKey,
      createdAt,
      ipHash,
    ).run();
  } catch (error) {
    if (imageKey) await env.REVIEW_IMAGES.delete(imageKey).catch(() => {});
    throw error;
  }

  try {
    await sendModerationEmail(env, publicOrigin, { id, name, email, rating, reviewText, imageKey, createdAt });
  } catch (error) {
    console.error("Moderation email failed", error);
    await Promise.allSettled([
      env.REVIEWS_DB.prepare("DELETE FROM reviews WHERE id = ?1 AND status = 'pending'").bind(id).run(),
      imageKey ? env.REVIEW_IMAGES.delete(imageKey) : Promise.resolve(),
    ]);
    return json({ error: "We could not receive your review right now. Please try again shortly." }, 503);
  }

  return json({ ok: true, message: "Thank you. Your review has been received." }, 202);
}

async function serveApprovedImage(env, reviewId) {
  if (!reviewId || reviewId.length > 80) return new Response("Not found", { status: 404 });
  const row = await env.REVIEWS_DB.prepare(
    "SELECT image_key FROM reviews WHERE id = ?1 AND status = 'approved'",
  ).bind(reviewId).first();
  if (!row?.image_key) return new Response("Not found", { status: 404 });

  const object = await env.REVIEW_IMAGES.get(row.image_key);
  if (!object?.body) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=86400");
  headers.set("x-content-type-options", "nosniff");
  return new Response(object.body, { headers });
}

async function serveModerationImage(env, url) {
  if (!hasReviewBindings(env)) return new Response("Not found", { status: 404 });

  const id = url.searchParams.get("id") || "";
  const action = url.searchParams.get("action") || "";
  const expires = Number.parseInt(url.searchParams.get("expires") || "0", 10);
  const token = url.searchParams.get("token") || "";
  const isCurrent = expires >= Math.floor(Date.now() / 1000);
  const valid = id && ["approve", "deny"].includes(action) && isCurrent
    && await verifyModerationToken(env.MODERATION_SECRET, id, action, expires, token);
  if (!valid) return new Response("Not found", { status: 404 });

  const row = await env.REVIEWS_DB.prepare(
    "SELECT image_key FROM reviews WHERE id = ?1 AND status = 'pending'",
  ).bind(id).first();
  if (!row?.image_key) return new Response("Not found", { status: 404 });

  const object = await env.REVIEW_IMAGES.get(row.image_key);
  if (!object?.body) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, no-store");
  headers.set("content-security-policy", "default-src 'none'");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-robots-tag", "noindex, nofollow");
  return new Response(object.body, { headers });
}

async function moderationConfirmation(env, url) {
  if (!hasReviewBindings(env)) {
    return moderationPage("Moderation is not configured.", "Complete the setup steps, then use the newest review email.", false, 503);
  }

  const id = url.searchParams.get("id") || "";
  const action = url.searchParams.get("action") || "";
  const expires = Number.parseInt(url.searchParams.get("expires") || "0", 10);
  const token = url.searchParams.get("token") || "";

  if (!id || !["approve", "deny"].includes(action) || !expires || expires < Math.floor(Date.now() / 1000)) {
    return moderationPage("This moderation link is invalid or expired.", "No change was made. Review links expire after 30 days.", false, 400);
  }

  const valid = await verifyModerationToken(env.MODERATION_SECRET, id, action, expires, token);
  if (!valid) return moderationPage("This moderation link is not valid.", "No change was made.", false, 403);

  const row = await env.REVIEWS_DB.prepare(
    "SELECT display_name, rating, review_text, image_key, status FROM reviews WHERE id = ?1",
  ).bind(id).first();
  if (!row) return moderationPage("That review no longer exists.", "No change was made.", false, 404);

  if (row.status !== "pending") {
    const previous = row.status === "approved" ? "approved" : "denied";
    return moderationPage(`This review was already ${previous}.`, "The first moderation choice is final, so no further change was made.", true, 200);
  }

  const actionLabel = action === "approve" ? "Approve and publish" : "Deny and keep private";
  const actionColor = action === "approve" ? "#238636" : "#b42318";
  const stars = "★".repeat(Number(row.rating)) + "☆".repeat(5 - Number(row.rating));
  const photoUrl = `/api/moderation-photo?id=${encodeURIComponent(id)}&action=${encodeURIComponent(action)}&expires=${expires}&token=${encodeURIComponent(token)}`;
  const photo = row.image_key
    ? `<figure style="margin:22px 0"><img src="${escapeHtml(photoUrl)}" alt="Customer photo submitted with this review" style="display:block;width:100%;max-height:420px;object-fit:contain;border-radius:12px;background:#0d0f10"><figcaption style="margin-top:10px;color:#ffffffa8;font-size:13px">This photo stays private unless you approve the review.</figcaption></figure>`
    : "";
  const body = `<p style="font-size:22px;color:#ff5a36;margin:0 0 18px">${stars}</p><p style="color:#ffffffa8">From <strong style="color:#fff">${escapeHtml(row.display_name)}</strong></p><blockquote style="margin:22px 0;padding:18px;border-left:3px solid #ff5a36;background:#ffffff0a;white-space:pre-wrap;line-height:1.7">${escapeHtml(row.review_text)}</blockquote>${photo}<form method="post" action="/review-moderate"><input type="hidden" name="id" value="${escapeHtml(id)}"><input type="hidden" name="action" value="${escapeHtml(action)}"><input type="hidden" name="expires" value="${expires}"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit" style="margin-top:18px;padding:14px 23px;border:0;border-radius:999px;background:${actionColor};color:#fff;font:inherit;font-weight:bold;cursor:pointer">${actionLabel}</button></form><p style="margin-top:18px;color:#ffffff73;font-size:12px">Nothing changes until you press the button above.</p>`;
  return moderationPage(`Confirm ${action === "approve" ? "approval" : "denial"}`, body, false, 200, true);
}

async function moderateReview(request, env) {
  if (!hasReviewBindings(env)) return moderationPage("Moderation is not configured.", "No change was made.", false, 503);
  const data = await request.formData();
  const id = clean(data.get("id"));
  const action = clean(data.get("action"));
  const expires = Number.parseInt(clean(data.get("expires")), 10);
  const token = clean(data.get("token"));

  if (!id || !["approve", "deny"].includes(action) || !expires || expires < Math.floor(Date.now() / 1000)) {
    return moderationPage("This moderation request is invalid or expired.", "No change was made.", false, 400);
  }
  if (!(await verifyModerationToken(env.MODERATION_SECRET, id, action, expires, token))) {
    return moderationPage("This moderation request is not valid.", "No change was made.", false, 403);
  }

  const row = await env.REVIEWS_DB.prepare(
    "SELECT display_name, image_key, status FROM reviews WHERE id = ?1",
  ).bind(id).first();
  if (!row) return moderationPage("That review no longer exists.", "No change was made.", false, 404);
  if (row.status !== "pending") {
    const previous = row.status === "approved" ? "approved" : "denied";
    if (row.status === "denied") await purgeDeniedReview(env, id, row.image_key);
    return moderationPage(`This review was already ${previous}.`, "The first moderation choice is final, so no further change was made.", true, 200);
  }

  const nextStatus = action === "approve" ? "approved" : "denied";
  const updated = await env.REVIEWS_DB.prepare(
    `UPDATE reviews
     SET status = ?1, moderated_at = ?2, approved_at = CASE WHEN ?1 = 'approved' THEN ?2 ELSE NULL END
     WHERE id = ?3 AND status = 'pending'`,
  ).bind(nextStatus, new Date().toISOString(), id).run();

  if (!updated.meta?.changes) {
    return moderationPage("This review has already been handled.", "The first moderation choice is final.", true, 200);
  }

  if (nextStatus === "denied" && row.image_key) {
    await purgeDeniedReview(env, id, row.image_key);
  } else if (nextStatus === "denied") {
    await purgeDeniedReview(env, id, null);
  }

  const verb = nextStatus === "approved" ? "approved and published" : "denied and kept private";
  return moderationPage(`Review ${verb}.`, `${row.display_name}'s review has been handled. The reviewer was not notified of your decision.`, true, 200);
}

async function sendModerationEmail(env, origin, review) {
  if (!env.RESEND_API_KEY || !env.REVIEW_FROM_EMAIL || !env.MODERATION_SECRET) {
    throw new Error("Email moderation secrets are missing");
  }

  const expires = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const approveToken = await moderationToken(env.MODERATION_SECRET, review.id, "approve", expires);
  const denyToken = await moderationToken(env.MODERATION_SECRET, review.id, "deny", expires);
  const link = (action, token) => `${origin}/review-moderate?id=${encodeURIComponent(review.id)}&action=${action}&expires=${expires}&token=${encodeURIComponent(token)}`;

  const stars = "★".repeat(review.rating) + "☆".repeat(5 - review.rating);
  const photoNote = review.imageKey ? "A customer photo is included. You can inspect it on either private confirmation page; it remains private unless approved." : "No photo was included.";
  const html = `<!doctype html><html><body style="margin:0;background:#f4f3ef;color:#101214;font-family:Arial,sans-serif"><div style="max-width:640px;margin:auto;padding:32px 20px"><div style="background:#101214;color:#fff;padding:28px;border-radius:16px"><p style="margin:0 0 8px;color:#ff5a36;font-size:12px;font-weight:bold;letter-spacing:.12em">NULOOK AUTO CARE</p><h1 style="margin:0;font-size:26px">New review awaiting moderation</h1></div><div style="padding:28px;background:#fff;border-radius:0 0 16px 16px"><p style="font-size:20px;color:#ff5a36;margin-top:0">${stars}</p><p><strong>Customer:</strong> ${escapeHtml(review.name)}</p><p><strong>Email:</strong> ${escapeHtml(review.email)}</p><p><strong>Submitted:</strong> ${escapeHtml(review.createdAt)}</p><div style="margin:22px 0;padding:18px;background:#f4f3ef;border-radius:10px;white-space:pre-wrap">${escapeHtml(review.reviewText)}</div><p style="color:#676b6e;font-size:13px">${photoNote}</p><p style="margin:28px 0 12px"><a href="${escapeHtml(link("approve", approveToken))}" style="display:inline-block;margin:0 10px 10px 0;padding:13px 22px;background:#238636;color:#fff;text-decoration:none;border-radius:999px;font-weight:bold">Review & approve</a><a href="${escapeHtml(link("deny", denyToken))}" style="display:inline-block;padding:13px 22px;background:#b42318;color:#fff;text-decoration:none;border-radius:999px;font-weight:bold">Review & deny</a></p><p style="color:#676b6e;font-size:12px;line-height:1.5">The buttons open a private confirmation page; they do not change anything by themselves. Links expire in 30 days. The reviewer receives only a neutral submission confirmation and will not be told which option you choose.</p></div></div></body></html>`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": `review-${review.id}`,
    },
    body: JSON.stringify({
      from: env.REVIEW_FROM_EMAIL,
      to: [env.REVIEW_MODERATOR_EMAIL || "nulookautocareaustralia@gmail.com"],
      reply_to: review.email,
      subject: `${review.rating}-star NuLook review from ${review.name}`,
      html,
    }),
  });

  if (!response.ok) throw new Error(`Email provider returned ${response.status}: ${await response.text()}`);
}

async function verifyTurnstile(token, remoteIp, secret, expectedHostname) {
  if (!token) return false;
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (remoteIp) body.append("remoteip", remoteIp);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  if (!response.ok) return false;
  const result = await response.json();
  return result.success === true && result.action === "review-submit"
    && (!expectedHostname || result.hostname === expectedHostname);
}

async function moderationToken(secret, id, action, expires) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${action}.${expires}`));
  return base64Url(new Uint8Array(signature));
}

async function verifyModerationToken(secret, id, action, expires, provided) {
  if (!secret || !provided) return false;
  const expected = await moderationToken(secret, id, action, expires);
  return timingSafeEqual(expected, provided);
}

async function hashIp(ip, secret, dateBucket) {
  if (!secret) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${dateBucket}:${ip}`));
  return base64Url(new Uint8Array(signature));
}

function moderationPage(title, detail, success, status, detailIsHtml = false) {
  const accent = success ? "#238636" : "#ff5a36";
  const content = detailIsHtml ? detail : `<p style="color:#ffffffa8;line-height:1.7">${escapeHtml(detail)}</p><a href="/" style="display:inline-block;margin-top:18px;padding:13px 22px;border-radius:999px;background:${accent};color:#fff;text-decoration:none;font-weight:bold">Return to website</a>`;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>NuLook review moderation</title></head><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#101214;color:#fff;font-family:Arial,sans-serif"><main style="width:min(560px,calc(100% - 40px));padding:40px;border:1px solid #ffffff2e;border-radius:22px;background:#1a1d20"><p style="color:${accent};font-size:12px;font-weight:bold;letter-spacing:.16em">NULOOK AUTO CARE</p><h1 style="font-size:clamp(30px,7vw,48px);line-height:1.05">${escapeHtml(title)}</h1>${content}</main></body></html>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow", "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" },
  });
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function hasReviewBindings(env) {
  return Boolean(env.REVIEWS_DB && env.REVIEW_IMAGES && env.IMAGES && env.MODERATION_SECRET);
}

function hasSubmissionBindings(env) {
  return hasReviewBindings(env) && Boolean(env.RESEND_API_KEY && env.REVIEW_FROM_EMAIL && env.REVIEW_MODERATOR_EMAIL)
    && !String(env.REVIEW_FROM_EMAIL).includes("YOUR_VERIFIED_DOMAIN") && Boolean(configuredPublicOrigin(env));
}

function configuredPublicOrigin(env, fallback = "") {
  const value = clean(env.PUBLIC_ORIGIN || fallback);
  try {
    const origin = new URL(value).origin;
    return origin === "null" || /YOUR_|REPLACE_/i.test(value) ? "" : origin;
  } catch (_error) {
    return "";
  }
}

function clean(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

function isUploadedFile(value) {
  return value && typeof value === "object" && typeof value.size === "number" && value.size > 0
    && typeof value.type === "string" && typeof value.stream === "function";
}

function isAcceptedImage(image) {
  return IMAGE_TYPES.has(image.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(String(image.name || ""));
}

async function purgeDeniedReview(env, id, imageKey) {
  if (imageKey) await env.REVIEW_IMAGES.delete(imageKey);
  await env.REVIEWS_DB.prepare("UPDATE reviews SET image_key = NULL WHERE id = ?1 AND status = 'denied'").bind(id).run();
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function timingSafeEqual(a, b) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
}
