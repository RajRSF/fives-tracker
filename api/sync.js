// Vercel serverless function — cross-device sync for KW Harriers Fives Tracker.
//
// Storage: Upstash Redis (provisioned via Vercel Marketplace KV/Upstash integration).
// Env vars discovered at request time — Vercel's Marketplace flow sometimes
// adds a custom prefix (e.g. STORAGE_KV_REST_API_URL) when the same Upstash
// DB is connected to multiple projects. We accept any of:
//   KV_REST_API_URL / KV_REST_API_TOKEN          (no prefix — default)
//   <PREFIX>_KV_REST_API_URL / ..._TOKEN         (any prefix Vercel set)
//   UPSTASH_REDIS_REST_URL / ..._TOKEN           (Upstash native names)
//
// Auth model: a 6-digit code IS the capability. Anyone with the code can read+write.
// This is intentional — no accounts, no email, no friction on the sideline.

export const config = { runtime: "edge" };

const KEY_PREFIX = "fives:";
const MAX_BLOB_BYTES = 256 * 1024; // 256 KB — fives data is tiny (~5 KB), this is comfortable headroom.

function resolveKvCreds() {
  const env = (typeof process !== "undefined" && process.env) ? process.env : {};
  // 1. Bare names (default integration).
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) {
    return { url: env.KV_REST_API_URL, token: env.KV_REST_API_TOKEN, source: "KV_REST_API_*" };
  }
  // 2. Upstash-native names.
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return { url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN, source: "UPSTASH_REDIS_REST_*" };
  }
  // 3. Custom prefix (e.g. STORAGE_KV_REST_API_URL). Find any *_KV_REST_API_URL
  //    that has a matching *_KV_REST_API_TOKEN.
  for (const key of Object.keys(env)) {
    if (key.endsWith("KV_REST_API_URL")) {
      const tokenKey = key.replace(/URL$/, "TOKEN");
      if (env[tokenKey]) {
        return { url: env[key], token: env[tokenKey], source: key + " / " + tokenKey };
      }
    }
    if (key.endsWith("UPSTASH_REDIS_REST_URL")) {
      const tokenKey = key.replace(/URL$/, "TOKEN");
      if (env[tokenKey]) {
        return { url: env[key], token: env[tokenKey], source: key + " / " + tokenKey };
      }
    }
  }
  return null;
}

function listEnvKeys() {
  const env = (typeof process !== "undefined" && process.env) ? process.env : {};
  return Object.keys(env)
    .filter(k => /KV|UPSTASH|REDIS|STORAGE/i.test(k))
    .sort();
}

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function isValidCode(code) {
  return typeof code === "string" && /^\d{6}$/.test(code);
}

async function kvGet(creds, code) {
  const res = await fetch(`${creds.url}/get/${KEY_PREFIX}${code}`, {
    headers: { authorization: `Bearer ${creds.token}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`KV GET ${res.status}`);
  const body = await res.json();
  return body.result;
}

async function kvSet(creds, code, value) {
  // Upstash REST /set/<key> takes the raw request body as the value.
  // `value` is already a JSON string — sending `JSON.stringify(value)`
  // would double-encode it and the GET would round-trip to a string,
  // not the object we expect.
  const res = await fetch(`${creds.url}/set/${KEY_PREFIX}${code}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${creds.token}`,
      "content-type": "text/plain",
    },
    body: value,
  });
  if (!res.ok) throw new Error(`KV SET ${res.status}`);
}

export default async function handler(req) {
  const u = new URL(req.url);

  // Diagnostic: GET /api/sync?diag=1 reveals which env vars match the KV/Upstash
  // patterns, without exposing their values. Lets us see what Vercel actually injected.
  if (req.method === "GET" && u.searchParams.get("diag") === "1") {
    const creds = resolveKvCreds();
    return json({
      kvConfigured: !!creds,
      source: creds ? creds.source : null,
      kvLikeEnvKeys: listEnvKeys()
    });
  }

  const creds = resolveKvCreds();
  if (!creds) {
    return json({
      error: "kv_not_configured",
      hint: "No env vars found matching KV_REST_API_*, UPSTASH_REDIS_REST_*, or *_KV_REST_API_*. Hit /api/sync?diag=1 to inspect available env keys.",
      kvLikeEnvKeys: listEnvKeys()
    }, { status: 503 });
  }

  if (req.method === "GET") {
    const code = u.searchParams.get("code");
    if (!isValidCode(code)) {
      return json({ error: "invalid_code" }, { status: 400 });
    }
    try {
      const stored = await kvGet(creds, code);
      if (!stored) return json({ exists: false });
      const parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
      return json({ exists: true, data: parsed.data, updated: parsed.updated || 0 });
    } catch (err) {
      return json({ error: "kv_read_failed", detail: String(err.message || err) }, { status: 502 });
    }
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_json" }, { status: 400 });
    }
    const { code, data } = body || {};
    if (!isValidCode(code)) {
      return json({ error: "invalid_code" }, { status: 400 });
    }
    if (data == null || typeof data !== "object") {
      return json({ error: "invalid_data" }, { status: 400 });
    }
    const payload = JSON.stringify({ data, updated: Date.now() });
    if (payload.length > MAX_BLOB_BYTES) {
      return json({ error: "payload_too_large" }, { status: 413 });
    }
    try {
      await kvSet(creds, code, payload);
      return json({ ok: true, updated: JSON.parse(payload).updated });
    } catch (err) {
      return json({ error: "kv_write_failed", detail: String(err.message || err) }, { status: 502 });
    }
  }

  return json({ error: "method_not_allowed" }, { status: 405 });
}
