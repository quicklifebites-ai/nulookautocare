const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_IMAGE_BYTES + 200_000;
const MAX_MODERATION_BYTES = 16 * 1024;
const MAX_REVIEW_LENGTH = 1200;
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const MODERATOR_EMAIL = "nulookautocareaustralia@gmail.com";
const schemaPromises = new WeakMap();

const REVIEW_TABLE_SQL = `CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review_text TEXT NOT NULL CHECK (length(review_text) BETWEEN 10 AND 1200),
  image_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  created_at TEXT NOT NULL,
  moderated_at TEXT,
  approved_at TEXT,
  ip_hash TEXT,
  notification_error TEXT
)`;

const TOKEN_TABLE_SQL = `CREATE TABLE IF NOT EXISTS review_moderation_tokens (
  review_id TEXT PRIMARY KEY,
  approve_token_hash TEXT NOT NULL UNIQUE,
  deny_token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE
)`;

const SETTINGS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS review_app_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;

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
        const encodedId = url.pathname.slice("/api/review-images/".length);
        let reviewId;
        try {
          reviewId = decodeURIComponent(encodedId);
        } catch (_error) {
          return new Response("Not found", { status: 404 });
        }
        return serveApprovedImage(env, reviewId);
      }

      if (url.pathname === "/api/moderation-photo" && request.method === "GET") {
        return serveModerationImage(env, url);
      }

      if (url.pathname === "/review-moderate" && request.method === "GET") {
        return moderationConfirmation(env, url);
      }

      if (url.pathname === "/review-moderate" && request.method === "POST") {
        return moderateReview(request, env, url);
      }

      if (url.pathname.startsWith("/api/")) {
        return json({ error: "Not found." }, 404);
      }

      if (env.ASSETS?.fetch) return env.ASSETS.fetch(request);
      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error("Review worker error", error);
      if (url.pathname === "/review-moderate") {
        return moderationPage("We could not process that review link.", "Please return to the moderation email and try again.", false, 500);
      }
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
  },

  async scheduled(_controller, env, context) {
    context.waitUntil(cleanupOldReviews(env));
  },
};

async function listApprovedReviews(env) {
  const db = env.REVIEWS_DB;
  if (!db) return json({ error: "Reviews are not configured yet." }, 503);
  await ensureSchema(db);

  const result = await db.prepare(
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

  return new Response(JSON.stringify({
    reviews,
    turnstileSiteKey: turnstileEnabled(env) ? env.TURNSTILE_SITE_KEY : null,
  }), {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      "cache-control": "public, max-age=30, stale-while-revalidate=120",
    },
  });
}

async function submitReview(request, env, url) {
  const db = env.REVIEWS_DB;
  if (!db) return json({ error: "Reviews are not configured yet." }, 503);

  if (!/^multipart\/form-data(?:;|$)/i.test(request.headers.get("content-type") || "")) {
    return json({ error: "This submission format is not supported." }, 415);
  }

  const declaredLengthHeader = request.headers.get("content-length");
  const declaredLength = Number(declaredLengthHeader);
  if (declaredLengthHeader && (!/^\d+$/.test(declaredLengthHeader) || !Number.isSafeInteger(declaredLength))) {
    return json({ error: "This submission format is not supported." }, 400);
  }
  if (declaredLengthHeader && declaredLength > MAX_MULTIPART_BYTES) {
    return json({ error: "That upload is too large. Please use an image under 5 MB." }, 413);
  }

  if (!isExactSameOrigin(request.headers.get("origin"), url.origin)) {
    return json({ error: "This submission could not be verified." }, 403);
  }

  await ensureSchema(db);
  let data;
  try {
    data = await readFormDataWithLimit(request, MAX_MULTIPART_BYTES);
  } catch (error) {
    if (error?.name === "PayloadTooLargeError") {
      return json({ error: "That upload is too large. Please use an image under 5 MB." }, 413);
    }
    throw error;
  }
  const honeypot = clean(data.get("website"));
  if (honeypot) return json({ ok: true, message: "Thank you. Your review has been received." }, 202);

  if (turnstilePartiallyConfigured(env)) {
    return json({ error: "Review verification is temporarily unavailable." }, 503);
  }
  if (turnstileEnabled(env)) {
    const token = clean(data.get("cf-turnstile-response"));
    const expectedHostname = clean(env.EXPECTED_TURNSTILE_HOSTNAME) || url.hostname;
    const verified = await verifyTurnstile(
      token,
      request.headers.get("CF-Connecting-IP"),
      env.TURNSTILE_SECRET_KEY,
      expectedHostname,
    );
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
  if (hasImage && (!env.REVIEW_IMAGES || !env.IMAGES)) {
    return json({ error: "Photo uploads are temporarily unavailable. You can still submit the review without a photo." }, 503);
  }
  if (hasImage && (!isAcceptedImage(image) || image.size > MAX_IMAGE_BYTES)) {
    return json({ error: "Please use a JPG, PNG, WebP or HEIC image under 5 MB." }, 400);
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const ip = clean(request.headers.get("CF-Connecting-IP"));
  let ipHash = null;
  if (ip) {
    const rateLimitPepper = await getRateLimitPepper(db);
    const currentBucket = createdAt.slice(0, 10);
    const previousBucket = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    ipHash = await hashIp(ip, currentBucket, rateLimitPepper);
    const previousIpHash = await hashIp(ip, previousBucket, rateLimitPepper);
    const recent = await db.prepare(
      "SELECT COUNT(*) AS count FROM reviews WHERE (ip_hash = ?1 OR ip_hash = ?2) AND created_at >= ?3",
    ).bind(ipHash, previousIpHash, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()).first();
    if (Number(recent?.count || 0) >= 5) {
      return json({ error: "Too many reviews were submitted recently. Please try again tomorrow." }, 429);
    }
  }

  let imageKey = null;
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

    imageKey = `reviews/${id}/review-photo.webp`;
    try {
      await env.REVIEW_IMAGES.put(imageKey, transformed.body, {
        httpMetadata: { contentType: "image/webp", cacheControl: "private, no-store" },
        customMetadata: { reviewId: id },
      });
    } catch (_error) {
      return json({ error: "That image could not be stored. Please try again." }, 500);
    }
  }

  const approveToken = randomToken();
  const denyToken = randomToken();
  const approveTokenHash = await sha256Text(approveToken);
  const denyTokenHash = await sha256Text(denyToken);
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;

  const insertReview = db.prepare(
    `INSERT INTO reviews
      (id, display_name, email, rating, review_text, image_key, status, created_at, ip_hash)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8)`,
  ).bind(id, name, email, rating, reviewText, imageKey, createdAt, ipHash);
  const insertTokens = db.prepare(
    `INSERT INTO review_moderation_tokens
      (review_id, approve_token_hash, deny_token_hash, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(id, approveTokenHash, denyTokenHash, expiresAt, createdAt);

  try {
    if (typeof db.batch === "function") {
      await db.batch([insertReview, insertTokens]);
    } else {
      await insertReview.run();
      await insertTokens.run();
    }
  } catch (error) {
    await cleanupPendingReview(env, id, imageKey);
    throw error;
  }

  try {
    await sendModerationEmail(env, url.origin, {
      id,
      name,
      email,
      rating,
      reviewText,
      imageKey,
      createdAt,
      approveToken,
      denyToken,
    });
  } catch (error) {
    console.error("All moderation email providers failed", error);
    await cleanupPendingReview(env, id, imageKey);
    return json({ error: "We could not receive your review right now. Please try again shortly." }, 503);
  }

  return json({ ok: true, message: "Thank you. Your review has been received." }, 202);
}

async function serveApprovedImage(env, reviewId) {
  if (!env.REVIEWS_DB || !env.REVIEW_IMAGES || !reviewId || reviewId.length > 80) {
    return new Response("Not found", { status: 404 });
  }
  await ensureSchema(env.REVIEWS_DB);
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
  if (!env.REVIEWS_DB || !env.REVIEW_IMAGES) return new Response("Not found", { status: 404 });
  await ensureSchema(env.REVIEWS_DB);
  const link = moderationParameters(url.searchParams);
  const result = await validateModerationLink(env.REVIEWS_DB, link);
  if (!result.ok || !result.row.image_key) return new Response("Not found", { status: 404 });

  const object = await env.REVIEW_IMAGES.get(result.row.image_key);
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
  if (!env.REVIEWS_DB) {
    return moderationPage("Moderation is not configured.", "The review database is unavailable.", false, 503);
  }
  await ensureSchema(env.REVIEWS_DB);
  const link = moderationParameters(url.searchParams);
  const result = await validateModerationLink(env.REVIEWS_DB, link);
  if (!result.ok) {
    const detail = result.reason === "expired"
      ? "No change was made. Review links expire after 30 days."
      : "No change was made. Please use the newest moderation email.";
    return moderationPage("This moderation link is invalid or expired.", detail, false, 400);
  }

  const row = result.row;
  const actionLabel = link.action === "approve" ? "Approve and publish" : "Deny and keep private";
  const actionColor = link.action === "approve" ? "#238636" : "#b42318";
  const stars = "★".repeat(Number(row.rating)) + "☆".repeat(5 - Number(row.rating));
  const photoUrl = `/api/moderation-photo?id=${encodeURIComponent(link.id)}&action=${encodeURIComponent(link.action)}&token=${encodeURIComponent(link.token)}`;
  const photo = row.image_key
    ? `<figure style="margin:22px 0"><img src="${escapeHtml(photoUrl)}" alt="Customer photo submitted with this review" style="display:block;width:100%;max-height:420px;object-fit:contain;border-radius:12px;background:#0d0f10"><figcaption style="margin-top:10px;color:#ffffffa8;font-size:13px">This photo stays private unless you approve the review.</figcaption></figure>`
    : "";
  const body = `<p style="font-size:22px;color:#ff5a36;margin:0 0 18px">${stars}</p><p style="color:#ffffffa8">From <strong style="color:#fff">${escapeHtml(row.display_name)}</strong></p><blockquote style="margin:22px 0;padding:18px;border-left:3px solid #ff5a36;background:#ffffff0a;white-space:pre-wrap;line-height:1.7">${escapeHtml(row.review_text)}</blockquote>${photo}<form method="post" action="/review-moderate"><input type="hidden" name="id" value="${escapeHtml(link.id)}"><input type="hidden" name="action" value="${escapeHtml(link.action)}"><input type="hidden" name="token" value="${escapeHtml(link.token)}"><button type="submit" style="margin-top:18px;padding:14px 23px;border:0;border-radius:999px;background:${actionColor};color:#fff;font:inherit;font-weight:bold;cursor:pointer">${actionLabel}</button></form><p style="margin-top:18px;color:#ffffff73;font-size:12px">Nothing changes until you press the button above.</p>`;
  return moderationPage(`Confirm ${link.action === "approve" ? "approval" : "denial"}`, body, false, 200, true);
}

async function moderateReview(request, env, url) {
  if (!env.REVIEWS_DB) return moderationPage("Moderation is not configured.", "No change was made.", false, 503);
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin && !isExactSameOrigin(requestOrigin, url.origin)) {
    return moderationPage("This moderation request is not valid.", "No change was made.", false, 403);
  }

  const contentType = request.headers.get("content-type") || "";
  if (!/^(?:application\/x-www-form-urlencoded|multipart\/form-data)(?:;|$)/i.test(contentType)) {
    return moderationPage("This moderation request is not valid.", "No change was made.", false, 415);
  }

  await ensureSchema(env.REVIEWS_DB);
  let data;
  try {
    data = await readFormDataWithLimit(request, MAX_MODERATION_BYTES);
  } catch (error) {
    if (error?.name === "PayloadTooLargeError") {
      return moderationPage("This moderation request is too large.", "No change was made.", false, 413);
    }
    throw error;
  }
  const link = {
    id: clean(data.get("id")),
    action: clean(data.get("action")),
    token: clean(data.get("token")),
  };
  const result = await validateModerationLink(env.REVIEWS_DB, link);
  if (!result.ok) return moderationPage("This moderation request is invalid or expired.", "No change was made.", false, 400);

  const nextStatus = link.action === "approve" ? "approved" : "denied";
  const moderatedAt = new Date().toISOString();
  const updated = await env.REVIEWS_DB.prepare(
    `UPDATE reviews
     SET status = ?1, moderated_at = ?2, approved_at = CASE WHEN ?1 = 'approved' THEN ?2 ELSE NULL END
     WHERE id = ?3 AND status = 'pending'`,
  ).bind(nextStatus, moderatedAt, link.id).run();

  if (!updated.meta?.changes) {
    return moderationPage("This review has already been handled.", "The first moderation choice is final.", true, 200);
  }

  await env.REVIEWS_DB.prepare("DELETE FROM review_moderation_tokens WHERE review_id = ?1").bind(link.id).run();
  if (nextStatus === "denied") await purgeDeniedPhoto(env, link.id, result.row.image_key);

  const verb = nextStatus === "approved" ? "approved and published" : "denied and kept private";
  return moderationPage(`Review ${verb}.`, `${result.row.display_name}'s review has been handled. The reviewer was not notified of your decision.`, true, 200);
}

async function validateModerationLink(db, link) {
  if (!link.id || link.id.length > 80 || !["approve", "deny"].includes(link.action) || !isPlausibleToken(link.token)) {
    return { ok: false, reason: "invalid" };
  }

  const row = await db.prepare(
    `SELECT r.display_name, r.rating, r.review_text, r.image_key, r.status,
            t.approve_token_hash, t.deny_token_hash, t.expires_at
     FROM reviews r
     INNER JOIN review_moderation_tokens t ON t.review_id = r.id
     WHERE r.id = ?1`,
  ).bind(link.id).first();
  if (!row || row.status !== "pending") return { ok: false, reason: "invalid" };
  if (Number(row.expires_at) < Math.floor(Date.now() / 1000)) return { ok: false, reason: "expired" };

  const providedHash = await sha256Text(link.token);
  const expectedHash = link.action === "approve" ? row.approve_token_hash : row.deny_token_hash;
  if (!timingSafeEqual(providedHash, String(expectedHash || ""))) return { ok: false, reason: "invalid" };
  return { ok: true, row };
}

async function sendModerationEmail(env, origin, review) {
  const moderatorEmail = clean(env.REVIEW_MODERATOR_EMAIL) || MODERATOR_EMAIL;
  const approveUrl = moderationUrl(origin, review.id, "approve", review.approveToken);
  const denyUrl = moderationUrl(origin, review.id, "deny", review.denyToken);
  let resendError = null;

  if (clean(env.RESEND_API_KEY) && clean(env.REVIEW_FROM_EMAIL)) {
    try {
      await sendWithResend(env, moderatorEmail, review, approveUrl, denyUrl);
      return;
    } catch (error) {
      resendError = error;
      console.error("Resend moderation email failed; trying FormSubmit", error);
    }
  }

  try {
    await sendWithFormSubmit(moderatorEmail, review, approveUrl, denyUrl);
  } catch (formSubmitError) {
    throw new Error(`Moderation email delivery failed${resendError ? " with both providers" : ""}: ${formSubmitError.message}`);
  }
}

async function sendWithResend(env, moderatorEmail, review, approveUrl, denyUrl) {
  const stars = "★".repeat(review.rating) + "☆".repeat(5 - review.rating);
  const photoNote = review.imageKey
    ? "A customer photo is included. Inspect it on either private confirmation page; it remains private unless approved."
    : "No photo was included.";
  const html = `<!doctype html><html><body style="margin:0;background:#f4f3ef;color:#101214;font-family:Arial,sans-serif"><div style="max-width:640px;margin:auto;padding:32px 20px"><div style="background:#101214;color:#fff;padding:28px;border-radius:16px"><p style="margin:0 0 8px;color:#ff5a36;font-size:12px;font-weight:bold;letter-spacing:.12em">NULOOK AUTO CARE</p><h1 style="margin:0;font-size:26px">New review awaiting moderation</h1></div><div style="padding:28px;background:#fff;border-radius:0 0 16px 16px"><p style="font-size:20px;color:#ff5a36;margin-top:0">${stars}</p><p><strong>Customer:</strong> ${escapeHtml(review.name)}</p><p><strong>Email:</strong> ${escapeHtml(review.email)}</p><p><strong>Submitted:</strong> ${escapeHtml(review.createdAt)}</p><div style="margin:22px 0;padding:18px;background:#f4f3ef;border-radius:10px;white-space:pre-wrap">${escapeHtml(review.reviewText)}</div><p style="color:#676b6e;font-size:13px">${photoNote}</p><p style="margin:28px 0 12px"><a href="${escapeHtml(approveUrl)}" style="display:inline-block;margin:0 10px 10px 0;padding:13px 22px;background:#238636;color:#fff;text-decoration:none;border-radius:999px;font-weight:bold">Review & approve</a><a href="${escapeHtml(denyUrl)}" style="display:inline-block;padding:13px 22px;background:#b42318;color:#fff;text-decoration:none;border-radius:999px;font-weight:bold">Review & deny</a></p><p style="color:#676b6e;font-size:12px;line-height:1.5">The buttons open a private confirmation page; they do not change anything by themselves. Links expire in 30 days.</p></div></div></body></html>`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": `review-${review.id}`,
    },
    body: JSON.stringify({
      from: env.REVIEW_FROM_EMAIL,
      to: [moderatorEmail],
      reply_to: review.email,
      subject: `${review.rating}-star NuLook review from ${review.name}`,
      html,
    }),
  });
  if (!response.ok) throw new Error(`Resend returned ${response.status}`);
}

async function sendWithFormSubmit(moderatorEmail, review, approveUrl, denyUrl) {
  const response = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(moderatorEmail)}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      _subject: `${review.rating}-star NuLook review from ${review.name}`,
      _template: "table",
      _captcha: "false",
      _replyto: review.email,
      Customer: review.name,
      "Customer email": review.email,
      Rating: `${review.rating} out of 5 stars`,
      Review: review.reviewText,
      Photo: review.imageKey ? "Included — inspect it through either private link below." : "No photo included.",
      "REVIEW AND APPROVE": approveUrl,
      "REVIEW AND DENY": denyUrl,
      Notice: "Opening a link does not change the review. Confirm the action on the private page. Links expire after 30 days.",
    }),
  });
  const payload = await response.json().catch(() => null);
  const accepted = payload?.success === true || payload?.success === "true";
  if (!response.ok || !accepted) {
    throw new Error(`FormSubmit returned ${response.status}`);
  }
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

async function ensureSchema(db) {
  let pending = schemaPromises.get(db);
  if (!pending) {
    pending = bootstrapSchema(db).catch((error) => {
      schemaPromises.delete(db);
      throw error;
    });
    schemaPromises.set(db, pending);
  }
  return pending;
}

async function bootstrapSchema(db) {
  const statements = [
    REVIEW_TABLE_SQL,
    TOKEN_TABLE_SQL,
    SETTINGS_TABLE_SQL,
    "CREATE INDEX IF NOT EXISTS reviews_public_index ON reviews(status, approved_at DESC)",
    "CREATE INDEX IF NOT EXISTS reviews_created_index ON reviews(created_at DESC)",
    "CREATE INDEX IF NOT EXISTS reviews_ip_created_index ON reviews(ip_hash, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS moderation_tokens_expiry_index ON review_moderation_tokens(expires_at)",
  ];
  for (const statement of statements) await db.prepare(statement).run();
}

async function getRateLimitPepper(db) {
  const existing = await db.prepare(
    "SELECT setting_value FROM review_app_settings WHERE setting_key = 'rate_limit_pepper'",
  ).first();
  if (existing?.setting_value) return existing.setting_value;

  const candidate = randomToken();
  await db.prepare(
    `INSERT OR IGNORE INTO review_app_settings (setting_key, setting_value, created_at)
     VALUES ('rate_limit_pepper', ?1, ?2)`,
  ).bind(candidate, new Date().toISOString()).run();
  const stored = await db.prepare(
    "SELECT setting_value FROM review_app_settings WHERE setting_key = 'rate_limit_pepper'",
  ).first();
  if (!stored?.setting_value) throw new Error("Could not initialize review rate-limit settings");
  return stored.setting_value;
}

async function cleanupOldReviews(env) {
  const db = env.REVIEWS_DB;
  if (!db) return;
  await ensureSchema(db);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const orphanCutoff = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  let expiredCursor = "";
  for (let batch = 0; batch < 5; batch += 1) {
    const expired = await db.prepare(
      `SELECT r.id, r.image_key
       FROM reviews r
       LEFT JOIN review_moderation_tokens t ON t.review_id = r.id
       WHERE r.status = 'pending'
         AND r.id > ?3
         AND ((t.expires_at IS NOT NULL AND t.expires_at < ?1)
           OR (t.review_id IS NULL AND r.created_at < ?2))
       ORDER BY r.id
       LIMIT 100`,
    ).bind(nowSeconds, orphanCutoff, expiredCursor).all();
    const rows = expired.results || [];
    if (!rows.length) break;

    for (const row of rows) {
      expiredCursor = row.id;
      if (row.image_key) {
        if (!env.REVIEW_IMAGES) {
          console.error("Expired review photo cleanup is waiting for the R2 binding", row.id);
          continue;
        }
        try {
          await env.REVIEW_IMAGES.delete(row.image_key);
        } catch (error) {
          console.error("Expired review photo cleanup failed", error);
          continue;
        }
      }
      await db.prepare("DELETE FROM review_moderation_tokens WHERE review_id = ?1").bind(row.id).run();
      await db.prepare("DELETE FROM reviews WHERE id = ?1 AND status = 'pending'").bind(row.id).run();
    }
    if (rows.length < 100) break;
  }

  let deniedCursor = "";
  for (let batch = 0; batch < 5; batch += 1) {
    const deniedWithPhotos = await db.prepare(
      `SELECT id, image_key FROM reviews
       WHERE status = 'denied' AND image_key IS NOT NULL AND id > ?1
       ORDER BY id
       LIMIT 100`,
    ).bind(deniedCursor).all();
    const rows = deniedWithPhotos.results || [];
    if (!rows.length) break;
    for (const row of rows) {
      deniedCursor = row.id;
      await purgeDeniedPhoto(env, row.id, row.image_key);
    }
    if (rows.length < 100) break;
  }

  const deniedCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare("DELETE FROM reviews WHERE status = 'denied' AND image_key IS NULL AND created_at < ?1").bind(deniedCutoff).run();
  await db.prepare(
    "DELETE FROM review_moderation_tokens WHERE expires_at < ?1 OR review_id IN (SELECT id FROM reviews WHERE status != 'pending')",
  ).bind(nowSeconds).run();
}

async function cleanupPendingReview(env, id, imageKey) {
  if (imageKey) {
    if (!env.REVIEW_IMAGES) {
      console.error("Pending review photo cleanup is waiting for the R2 binding", id);
      await recordCleanupError(env.REVIEWS_DB, id, "Photo cleanup is waiting for storage.");
      return false;
    }
    try {
      await env.REVIEW_IMAGES.delete(imageKey);
    } catch (error) {
      console.error("Pending review photo cleanup failed", error);
      await recordCleanupError(env.REVIEWS_DB, id, "Photo cleanup will be retried.");
      return false;
    }
  }

  if (env.REVIEWS_DB) {
    try {
      await env.REVIEWS_DB.prepare("DELETE FROM review_moderation_tokens WHERE review_id = ?1").bind(id).run();
      await env.REVIEWS_DB.prepare("DELETE FROM reviews WHERE id = ?1 AND status = 'pending'").bind(id).run();
    } catch (error) {
      console.error("Pending review database cleanup failed", error);
      return false;
    }
  }
  return true;
}

async function recordCleanupError(db, id, message) {
  if (!db) return;
  try {
    await db.prepare(
      "UPDATE reviews SET notification_error = ?1 WHERE id = ?2 AND status = 'pending'",
    ).bind(message, id).run();
  } catch (error) {
    console.error("Could not record pending cleanup status", error);
  }
}

async function purgeDeniedPhoto(env, id, imageKey) {
  if (!env.REVIEWS_DB) return;
  if (imageKey && env.REVIEW_IMAGES) {
    try {
      await env.REVIEW_IMAGES.delete(imageKey);
    } catch (error) {
      console.error("Denied review photo cleanup failed", error);
      return;
    }
  } else if (imageKey) {
    return;
  }
  await env.REVIEWS_DB.prepare(
    "UPDATE reviews SET image_key = NULL WHERE id = ?1 AND status = 'denied'",
  ).bind(id).run();
}

function moderationParameters(searchParams) {
  return {
    id: clean(searchParams.get("id")),
    action: clean(searchParams.get("action")),
    token: clean(searchParams.get("token")),
  };
}

function moderationUrl(origin, id, action, token) {
  const url = new URL("/review-moderate", origin);
  url.searchParams.set("id", id);
  url.searchParams.set("action", action);
  url.searchParams.set("token", token);
  return url.href;
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Text(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

async function hashIp(ip, dateBucket, pepper) {
  return sha256Text(`${pepper}:${dateBucket}:${ip}`);
}

function isExactSameOrigin(originHeader, expectedOrigin) {
  if (!originHeader) return false;
  try {
    return new URL(originHeader).origin === new URL(expectedOrigin).origin;
  } catch (_error) {
    return false;
  }
}

function turnstileEnabled(env) {
  return Boolean(clean(env.TURNSTILE_SITE_KEY) && clean(env.TURNSTILE_SECRET_KEY));
}

function turnstilePartiallyConfigured(env) {
  return Boolean(clean(env.TURNSTILE_SITE_KEY)) !== Boolean(clean(env.TURNSTILE_SECRET_KEY));
}

function moderationPage(title, detail, success, status, detailIsHtml = false) {
  const accent = success ? "#238636" : "#ff5a36";
  const content = detailIsHtml ? detail : `<p style="color:#ffffffa8;line-height:1.7">${escapeHtml(detail)}</p><a href="/" style="display:inline-block;margin-top:18px;padding:13px 22px;border-radius:999px;background:${accent};color:#fff;text-decoration:none;font-weight:bold">Return to website</a>`;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>NuLook review moderation</title></head><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#101214;color:#fff;font-family:Arial,sans-serif"><main style="width:min(560px,calc(100% - 40px));padding:40px;border:1px solid #ffffff2e;border-radius:22px;background:#1a1d20"><p style="color:${accent};font-size:12px;font-weight:bold;letter-spacing:.16em">NULOOK AUTO CARE</p><h1 style="font-size:clamp(30px,7vw,48px);line-height:1.05">${escapeHtml(title)}</h1>${content}</main></body></html>`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function clean(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

async function readFormDataWithLimit(request, maximumBytes) {
  if (!request.body) throw new TypeError("Missing request body");
  const reader = request.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maximumBytes) {
      await reader.cancel().catch(() => {});
      const error = new Error("Multipart payload exceeds the configured limit");
      error.name = "PayloadTooLargeError";
      throw error;
    }
    chunks.push(value);
  }

  return new Response(new Blob(chunks), {
    headers: { "content-type": request.headers.get("content-type") || "" },
  }).formData();
}

function isUploadedFile(value) {
  return value && typeof value === "object" && typeof value.size === "number" && value.size > 0
    && typeof value.type === "string" && typeof value.stream === "function";
}

function isAcceptedImage(image) {
  return IMAGE_TYPES.has(image.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(String(image.name || ""));
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isPlausibleToken(value) {
  return /^[A-Za-z0-9_-]{40,100}$/.test(value);
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
