import assert from 'node:assert/strict';
import worker from '../worker/index.js';

globalThis.btoa ??= (value) => Buffer.from(value, 'binary').toString('base64');

class MockStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.replace(/\s+/g, ' ').trim();
    this.args = [];
  }

  bind(...args) { this.args = args; return this; }

  async all() {
    if (this.sql.includes("FROM reviews") && this.sql.includes("WHERE status = 'approved'")) {
      return {
        results: [...this.db.rows.values()]
          .filter((row) => row.status === 'approved')
          .sort((a, b) => String(b.approved_at).localeCompare(String(a.approved_at))),
      };
    }
    throw new Error(`Unsupported all: ${this.sql}`);
  }

  async first() {
    if (this.sql.startsWith('SELECT setting_value FROM review_app_settings')) {
      const value = this.db.settings.get('rate_limit_pepper');
      return value ? { setting_value: value } : null;
    }
    if (this.sql.startsWith('SELECT COUNT(*)')) {
      const [currentHash, previousHash, since] = this.args;
      const count = [...this.db.rows.values()].filter((row) => (
        row.ip_hash === currentHash || row.ip_hash === previousHash
      ) && row.created_at >= since).length;
      return { count };
    }
    if (this.sql.includes("SELECT image_key FROM reviews WHERE id = ?1 AND status = 'approved'")) {
      const row = this.db.rows.get(this.args[0]);
      return row?.status === 'approved' ? { image_key: row.image_key } : null;
    }
    if (this.sql.includes('INNER JOIN review_moderation_tokens')) {
      const row = this.db.rows.get(this.args[0]);
      const tokens = this.db.tokens.get(this.args[0]);
      return row && tokens ? { ...row, ...tokens } : null;
    }
    throw new Error(`Unsupported first: ${this.sql}`);
  }

  async run() {
    if (this.sql.startsWith('CREATE TABLE') || this.sql.startsWith('CREATE INDEX')) {
      return { meta: { changes: 0 } };
    }
    if (this.sql.startsWith('INSERT INTO reviews')) {
      const [id, display_name, email, rating, review_text, image_key, created_at, ip_hash] = this.args;
      this.db.rows.set(id, {
        id, display_name, email, rating, review_text, image_key,
        status: 'pending', created_at, moderated_at: null, approved_at: null, ip_hash,
      });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith('INSERT INTO review_moderation_tokens')) {
      const [review_id, approve_token_hash, deny_token_hash, expires_at, created_at] = this.args;
      this.db.tokens.set(review_id, { approve_token_hash, deny_token_hash, expires_at, created_at });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith('INSERT OR IGNORE INTO review_app_settings')) {
      if (!this.db.settings.has('rate_limit_pepper')) this.db.settings.set('rate_limit_pepper', this.args[0]);
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith('UPDATE reviews SET status')) {
      const [status, moderated_at, id] = this.args;
      const row = this.db.rows.get(id);
      if (!row || row.status !== 'pending') return { meta: { changes: 0 } };
      row.status = status;
      row.moderated_at = moderated_at;
      row.approved_at = status === 'approved' ? moderated_at : null;
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith('UPDATE reviews SET image_key = NULL')) {
      const row = this.db.rows.get(this.args[0]);
      if (row?.status === 'denied') row.image_key = null;
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (this.sql.startsWith('DELETE FROM review_moderation_tokens')) {
      return { meta: { changes: this.db.tokens.delete(this.args[0]) ? 1 : 0 } };
    }
    if (this.sql.startsWith('DELETE FROM reviews')) {
      const row = this.db.rows.get(this.args[0]);
      if (row?.status === 'pending') this.db.rows.delete(this.args[0]);
      return { meta: { changes: row ? 1 : 0 } };
    }
    throw new Error(`Unsupported run: ${this.sql}`);
  }
}

function makeDb() {
  return {
    rows: new Map(),
    tokens: new Map(),
    settings: new Map(),
    prepare(sql) { return new MockStatement(this, sql); },
    async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); },
  };
}

function makeStorage() {
  const objects = new Map();
  return {
    objects,
    binding: {
      async put(key, body, options) {
        objects.set(key, { bytes: new Uint8Array(await new Response(body).arrayBuffer()), options });
      },
      async get(key) {
        const stored = objects.get(key);
        return stored ? {
          body: stored.bytes,
          httpEtag: 'etag',
          writeHttpMetadata(headers) { headers.set('content-type', stored.options.httpMetadata.contentType); },
        } : null;
      },
      async delete(key) { objects.delete(key); },
    },
  };
}

const images = {
  input(stream) {
    return {
      transform() { return this; },
      output() {
        return {
          response() {
            stream.cancel().catch(() => {});
            return new Response(new Uint8Array([82, 73, 70, 70]), { headers: { 'content-type': 'image/webp' } });
          },
        };
      },
    };
  },
};

const db = makeDb();
const storage = makeStorage();
const baseEnv = {
  REVIEWS_DB: db,
  ASSETS: { fetch: () => new Response('asset') },
};

const sentEmails = [];
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input).startsWith('https://formsubmit.co/ajax/')) {
    sentEmails.push(JSON.parse(init.body));
    return Response.json({ success: true });
  }
  return nativeFetch(input, init);
};

function reviewForm({ name, rating = '5', text, photo } = {}) {
  const form = new FormData();
  form.set('name', name || 'Jamie Customer');
  form.set('email', 'jamie@example.com');
  form.set('rating', rating);
  form.set('review', text || 'A careful service and an excellent finish.');
  if (photo) form.set('photo', photo);
  return form;
}

// Text-only submissions work without R2 or Images bindings.
const textSubmit = await worker.fetch(new Request('https://example.com/api/reviews', {
  method: 'POST',
  headers: { origin: 'https://example.com', 'CF-Connecting-IP': '203.0.113.10' },
  body: reviewForm(),
}), baseEnv);
assert.equal(textSubmit.status, 202);
assert.equal(sentEmails.length, 1);
assert.equal(db.rows.size, 1);
assert.equal(db.tokens.size, 1);
assert.match(db.settings.get('rate_limit_pepper'), /^[A-Za-z0-9_-]{40,100}$/);

const [textReview] = [...db.rows.values()];
const textTokens = db.tokens.get(textReview.id);
const approveUrl = sentEmails[0]['REVIEW AND APPROVE'];
assert(approveUrl.startsWith('https://example.com/review-moderate?'));
assert(!JSON.stringify(textTokens).includes(new URL(approveUrl).searchParams.get('token')), 'D1 must store only token hashes');

const beforeConfirmation = JSON.stringify({ row: textReview, tokens: textTokens });
const confirmation = await worker.fetch(new Request(approveUrl), baseEnv);
assert.equal(confirmation.status, 200);
assert.equal(JSON.stringify({ row: textReview, tokens: textTokens }), beforeConfirmation, 'GET moderation must not mutate');

const approveParams = new URL(approveUrl).searchParams;
const approveForm = new URLSearchParams();
for (const key of ['id', 'action', 'token']) approveForm.set(key, approveParams.get(key));
const approved = await worker.fetch(new Request('https://example.com/review-moderate', {
  method: 'POST',
  headers: { origin: 'https://example.com' },
  body: approveForm,
}), baseEnv);
assert.equal(approved.status, 200);
assert.equal(textReview.status, 'approved');
assert.equal(db.tokens.has(textReview.id), false, 'moderation tokens must be single-use');

const listed = await worker.fetch(new Request('https://example.com/api/reviews'), baseEnv);
const publicPayload = await listed.json();
assert.equal(publicPayload.reviews.length, 1);
assert.equal(publicPayload.reviews[0].email, undefined);

// Photo moderation stays private and denial removes the R2 object.
const photo = new File([new Uint8Array([82, 73, 70, 70])], 'customer.webp', { type: 'image/webp' });
const photoEnv = { ...baseEnv, REVIEW_IMAGES: storage.binding, IMAGES: images };
const photoSubmit = await worker.fetch(new Request('https://example.com/api/reviews', {
  method: 'POST',
  headers: { origin: 'https://example.com', 'CF-Connecting-IP': '203.0.113.11' },
  body: reviewForm({ name: 'Taylor Customer', photo }),
}), photoEnv);
assert.equal(photoSubmit.status, 202);
assert.equal(storage.objects.size, 1);

const denyUrl = sentEmails[1]['REVIEW AND DENY'];
const denyParams = new URL(denyUrl).searchParams;
const pendingPhoto = await worker.fetch(new Request(`https://example.com/api/moderation-photo?${denyParams}`), photoEnv);
assert.equal(pendingPhoto.status, 200);

const denyForm = new URLSearchParams();
for (const key of ['id', 'action', 'token']) denyForm.set(key, denyParams.get(key));
const denied = await worker.fetch(new Request('https://example.com/review-moderate', {
  method: 'POST',
  headers: { origin: 'https://example.com' },
  body: denyForm,
}), photoEnv);
assert.equal(denied.status, 200);
assert.equal(storage.objects.size, 0);
assert.equal((await worker.fetch(new Request(`https://example.com/api/moderation-photo?${denyParams}`), photoEnv)).status, 404);

const wrongOrigin = await worker.fetch(new Request('https://example.com/api/reviews', {
  method: 'POST',
  headers: { origin: 'https://attacker.example' },
  body: reviewForm(),
}), baseEnv);
assert.equal(wrongOrigin.status, 403);

const multipartModeration = new FormData();
for (const key of ['id', 'action', 'token']) multipartModeration.set(key, approveParams.get(key));
const rejectedMultipartModeration = await worker.fetch(new Request('https://example.com/review-moderate', {
  method: 'POST',
  headers: { origin: 'https://example.com' },
  body: multipartModeration,
}), baseEnv);
assert.equal(rejectedMultipartModeration.status, 415, 'moderation accepts only the confirmation form content type');

const declaredOversizedModeration = await worker.fetch(new Request('https://example.com/review-moderate', {
  method: 'POST',
  headers: {
    origin: 'https://example.com',
    'content-type': 'application/x-www-form-urlencoded',
    'content-length': String(16 * 1024 + 1),
  },
  body: 'id=x&action=approve&token=y',
}), baseEnv);
assert.equal(declaredOversizedModeration.status, 413, 'declared oversized moderation bodies must be rejected before parsing');

const malformedLengthModeration = await worker.fetch(new Request('https://example.com/review-moderate', {
  method: 'POST',
  headers: {
    origin: 'https://example.com',
    'content-type': 'application/x-www-form-urlencoded',
    'content-length': 'not-a-number',
  },
  body: 'id=x&action=approve&token=y',
}), baseEnv);
assert.equal(malformedLengthModeration.status, 400, 'malformed moderation content lengths must be rejected');

const oversizedModeration = await worker.fetch(new Request('https://example.com/review-moderate', {
  method: 'POST',
  headers: { origin: 'https://example.com' },
  body: new URLSearchParams({ id: 'x'.repeat(20_000), action: 'approve', token: 'y'.repeat(43) }),
}), baseEnv);
assert.equal(oversizedModeration.status, 413, 'moderation form bodies must be stream-capped');

globalThis.fetch = nativeFetch;
console.log('Review worker smoke: PASS');
