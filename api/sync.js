// Vercel serverless function — cross-device sync for KW Harriers Fives Tracker.
//
// Storage: Upstash Redis (provisioned via Vercel Marketplace KV/Upstash integration).
// Required env vars (set in the Vercel dashboard):
//   KV_REST_API_URL      — Upstash REST endpoint, e.g. https://<id>.upstash.io
//   KV_REST_API_TOKEN    — Upstash REST token (read+write)
//
// Auth model: a 6-digit code IS the capability. Anyone with the code can read+write.
// This is intentional — no accounts, no email, no friction on the sideline.

export const config = { runtime: "edge" };

const KEY_PREFIX = "fives:";
const MAX_BLOB_BYTES = 256 * 1024; // 256 KB — fives data is tiny (~5 KB), this is comfortable headroom.

const url = process.env.KV_REST_API_URL;
const token = process.env.KV_REST_API_TOKEN;

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

async function kvGet(code) {
  const res = await fetch(`${url}/get/${KEY_PREFIX}${code}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`KV GET ${res.status}`);
  const body = await res.json();
  return body.result;
}

async function kvSet(code, value) {
  const res = await fetch(`${url}/set/${KEY_PREFIX}${code}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`KV SET ${res.status}`);
}

export default async function handler(req) {
  if (!url || !token) {
    return json({ error: "kv_not_configured" }, { status: 503 });
  }

  if (req.method === "GET") {
    const u = new URL(req.url);
    const code = u.searchParams.get("code");
    if (!isValidCode(code)) {
      return json({ error: "invalid_code" }, { status: 400 });
    }
    try {
      const stored = await kvGet(code);
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
      await kvSet(code, payload);
      return json({ ok: true, updated: JSON.parse(payload).updated });
    } catch (err) {
      return json({ error: "kv_write_failed", detail: String(err.message || err) }, { status: 502 });
    }
  }

  return json({ error: "method_not_allowed" }, { status: 405 });
}
