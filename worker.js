// Prabhvas Fashions — Admin Worker (v2)
// Single-file Cloudflare Worker: paste this whole thing into the Cloudflare
// dashboard's Quick Edit editor. No npm dependencies, no build step.
//
// What changed from v1:
//   - Your admin password and authenticator-app secret now live in Workers
//     KV (a small key/value store this Worker can read AND write at
//     runtime) instead of Worker "secrets" (which only the Cloudflare
//     dashboard can change). That's what makes self-service password
//     changes and 2FA management possible from the admin panel itself.
//   - A one-time /api/install step (mirrors a typical "create your admin
//     account" wizard) replaces the old offline hash-generator.html tool —
//     you type your password once into the admin panel itself, over HTTPS,
//     and this Worker hashes it immediately server-side. It is never
//     stored, logged, or visible in plain text anywhere, before or after.
//   - Login and 2FA attempts are now throttled (5 tries, then a 5-minute
//     lock), tracked in the same KV namespace.
//   - Categories, products (with nested SKU/colour/size variants), and
//     site settings are three separate JSON files in your GitHub repo,
//     all readable/writable through this Worker the same way
//     products.json always was.
//
// Routes:
//   GET  /api/install-status                              -> { needsInstall }
//   POST /api/install         { password, enableTotp, email } -> { totpSecret? }
//   POST /api/login           { password }                 -> { challenge, totpEnabled, emailSent }
//   POST /api/verify-2fa      { challenge, code }           -> { token }
//   GET  /api/data            (Bearer token)                -> { products, categories, settings, shas }
//   POST /api/publish         (Bearer token) { products?, categories?, settings?, shas, photos } -> { success, shas }
//   POST /api/change-password (Bearer token) { currentPassword, newPassword } -> { success }
//   POST /api/totp/regenerate (Bearer token)                 -> { totpSecret }
//   POST /api/totp/disable    (Bearer token)                 -> { success }
//   POST /api/email-2fa       (Bearer token) { email }        -> { success }
//   GET  /api/health                                          -> { ok: true }
//
// Required bindings/secrets (Cloudflare dashboard -> Worker -> Settings):
//   KV namespace binding ADMIN_KV     (Settings -> Bindings -> KV Namespace)
//   SESSION_SECRET       any long random string, used to sign short-lived tokens
//   GITHUB_TOKEN         a GitHub Personal Access Token with repo contents write access
//   GITHUB_OWNER         e.g. "prabhvasfashions"
//   GITHUB_REPO          e.g. "prabhvas-fashions"
//   ALLOWED_ORIGIN        e.g. "https://prabhvasfashions.github.io"
// Optional secrets (only needed if you want emailed 2FA codes as a channel):
//   EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY
//   (which address receives the code is set from the admin panel itself, not a secret)

// ============================================================
// Crypto core
// ============================================================

const te = new TextEncoder();

function toB64Url(bytes) {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

async function pbkdf2Raw(password, saltBytes, iterations) {
  const keyMaterial = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

// Cloudflare Workers' crypto.subtle caps PBKDF2 at 100,000 iterations.
async function hashPassword(password, iterations = 100000) {
  const salt = randomBytes(16);
  const hash = await pbkdf2Raw(password, salt, iterations);
  return `pbkdf2$${iterations}$${toB64Url(salt)}$${toB64Url(hash)}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = parseInt(parts[1], 10);
  const salt = fromB64Url(parts[2]);
  const expected = fromB64Url(parts[3]);
  const actual = await pbkdf2Raw(password, salt, iterations);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(bytes) {
  let bits = 0, value = 0, out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  str = str.replace(/=+$/, "").toUpperCase().replace(/\s+/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of str) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function generateTotpSecret() {
  return base32Encode(randomBytes(20)); // 160-bit secret, standard for TOTP
}

async function hmacSha1(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, msgBytes);
  return new Uint8Array(sig);
}

async function totpAt(secretBase32, unixSeconds, step = 30, digits = 6) {
  const counter = Math.floor(unixSeconds / step);
  const counterBytes = new Uint8Array(8);
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  const key = base32Decode(secretBase32);
  const hmac = await hmacSha1(key, counterBytes);
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const code = (binCode % 10 ** digits).toString().padStart(digits, "0");
  return code;
}

async function verifyTotp(secretBase32, code, unixSeconds, windowSteps = 1, step = 30) {
  code = String(code).trim();
  for (let w = -windowSteps; w <= windowSteps; w++) {
    const candidate = await totpAt(secretBase32, unixSeconds + w * step, step);
    if (candidate === code) return true;
  }
  return false;
}

async function hmacSha256Sign(secret, msgBytes) {
  const key = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, msgBytes);
  return new Uint8Array(sig);
}

async function signToken(payload, secret) {
  const body = te.encode(JSON.stringify(payload));
  const bodyB64 = toB64Url(body);
  const sig = await hmacSha256Sign(secret, te.encode(bodyB64));
  return `${bodyB64}.${toB64Url(sig)}`;
}

async function verifyToken(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const [bodyB64, sigB64] = parts;
  const expectedSig = await hmacSha256Sign(secret, te.encode(bodyB64));
  let actualSig;
  try {
    actualSig = fromB64Url(sigB64);
  } catch {
    return null;
  }
  if (actualSig.length !== expectedSig.length) return null;
  let diff = 0;
  for (let i = 0; i < actualSig.length; i++) diff |= actualSig[i] ^ expectedSig[i];
  if (diff !== 0) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64Url(bodyB64)));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

async function sha256Hex(str) {
  const digest = await crypto.subtle.digest("SHA-256", te.encode(str));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================
// Small helpers
// ============================================================

function randomOtp6() {
  const max = 1000000;
  const limit = Math.floor(0xffffffff / max) * max;
  let n;
  do {
    n = new Uint32Array(1);
    crypto.getRandomValues(n);
    n = n[0];
  } while (n >= limit);
  return String(n % max).padStart(6, "0");
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(env) },
  });
}

function encodePath(path) {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

async function requireSession(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/.exec(auth);
  if (!m) return null;
  const payload = await verifyToken(m[1], env.SESSION_SECRET);
  if (!payload || payload.purpose !== "session") return null;
  return payload;
}

// ============================================================
// Workers KV — admin credentials + login throttling.
// Never exposed to the browser; read/written only from inside this Worker.
// ============================================================

const KV_PASSWORD_HASH = "admin_password_hash";
const KV_TOTP_SECRET = "admin_totp_secret";
const KV_ADMIN_EMAIL = "admin_email";

async function kvGetJSON(env, key) {
  const raw = await env.ADMIN_KV.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const THROTTLE_MAX_ATTEMPTS = 5;
const THROTTLE_LOCK_SECONDS = 300;

// Returns seconds remaining if currently locked, or null if not locked.
async function checkThrottle(env, key) {
  const state = await kvGetJSON(env, key);
  if (state && state.lockedUntil && state.lockedUntil > Date.now() / 1000) {
    return Math.ceil(state.lockedUntil - Date.now() / 1000);
  }
  return null;
}

async function failThrottle(env, key) {
  const state = (await kvGetJSON(env, key)) || { count: 0, lockedUntil: 0 };
  state.count = (state.count || 0) + 1;
  let ttl = 900; // keep the failure counter around for 15 min of inactivity
  if (state.count >= THROTTLE_MAX_ATTEMPTS) {
    state.lockedUntil = Math.floor(Date.now() / 1000) + THROTTLE_LOCK_SECONDS;
    state.count = 0;
    ttl = THROTTLE_LOCK_SECONDS + 60;
  }
  await env.ADMIN_KV.put(key, JSON.stringify(state), { expirationTtl: ttl });
}

async function resetThrottle(env, key) {
  await env.ADMIN_KV.delete(key);
}

// ============================================================
// GitHub Contents API (server-side — token never leaves the Worker)
// ============================================================

function ghApiBase(env) {
  return `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents`;
}

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "prabhvas-fashions-admin-worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function ghGetFile(env, path) {
  const res = await fetch(`${ghApiBase(env)}/${encodePath(path)}`, { headers: ghHeaders(env) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { contentBase64: data.content, sha: data.sha };
}

async function ghGetJSON(env, path) {
  const file = await ghGetFile(env, path);
  if (!file) return { data: null, sha: null };
  const bin = atob(file.contentBase64.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const text = new TextDecoder().decode(bytes);
  return { data: JSON.parse(text), sha: file.sha };
}

async function ghPutFile(env, path, base64Content, message, sha) {
  const body = { message, content: base64Content, branch: "main" };
  if (sha) body.sha = sha;
  const res = await fetch(`${ghApiBase(env)}/${encodePath(path)}`, {
    method: "PUT",
    headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`GitHub PUT ${path} failed: ${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function b64EncodeText(str) {
  const bytes = te.encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

async function ghPutJSON(env, path, data, message, sha) {
  const result = await ghPutFile(env, path, b64EncodeText(JSON.stringify(data, null, 2)), message, sha);
  return result.content.sha;
}

// ============================================================
// EmailJS (email OTP channel)
// ============================================================

async function sendOtpEmail(env, toEmail, otp) {
  if (!env.EMAILJS_SERVICE_ID || !env.EMAILJS_TEMPLATE_ID || !env.EMAILJS_PUBLIC_KEY || !toEmail) {
    return false;
  }
  const body = {
    service_id: env.EMAILJS_SERVICE_ID,
    template_id: env.EMAILJS_TEMPLATE_ID,
    user_id: env.EMAILJS_PUBLIC_KEY,
    accessToken: env.EMAILJS_PRIVATE_KEY || undefined,
    template_params: {
      passcode: otp,
      otp_code: otp,
      code: otp,
      to_email: toEmail,
      email: toEmail,
    },
  };
  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok;
}

function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ""));
}

// ============================================================
// Route handlers — install & credentials
// ============================================================

async function handleInstallStatus(request, env) {
  const hash = await env.ADMIN_KV.get(KV_PASSWORD_HASH);
  return json({ needsInstall: !hash }, 200, env);
}

async function handleInstall(request, env) {
  const existing = await env.ADMIN_KV.get(KV_PASSWORD_HASH);
  if (existing) {
    return json({ error: "An admin account already exists. This can only be run once." }, 403, env);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request body." }, 400, env);
  }

  const password = String(body.password || "");
  const enableTotp = !!body.enableTotp;
  const email = String(body.email || "").trim();

  if (password.length < 8) return json({ error: "Password must be at least 8 characters." }, 400, env);
  if (email && !isValidEmail(email)) return json({ error: "That email address doesn't look valid." }, 400, env);
  if (!enableTotp && !email) {
    return json({ error: "Turn on at least one 2FA method: authenticator app, email, or both." }, 400, env);
  }

  const hash = await hashPassword(password);
  await env.ADMIN_KV.put(KV_PASSWORD_HASH, hash);

  let totpSecret = null;
  if (enableTotp) {
    totpSecret = generateTotpSecret();
    await env.ADMIN_KV.put(KV_TOTP_SECRET, totpSecret);
  }
  if (email) {
    await env.ADMIN_KV.put(KV_ADMIN_EMAIL, email);
  }

  return json({ totpSecret }, 200, env);
}

async function handleLogin(request, env) {
  const locked = await checkThrottle(env, "throttle:login");
  if (locked) return json({ error: `Too many attempts. Try again in about ${Math.ceil(locked / 60)} minute(s).` }, 429, env);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request body." }, 400, env);
  }
  const password = String(body.password || "");
  if (!password) return json({ error: "Password is required." }, 400, env);

  const storedHash = await env.ADMIN_KV.get(KV_PASSWORD_HASH);
  if (!storedHash) {
    return json({ error: "No admin account exists yet — run the one-time setup first." }, 500, env);
  }

  const valid = await verifyPassword(password, storedHash);
  if (!valid) {
    await failThrottle(env, "throttle:login");
    return json({ error: "Incorrect password." }, 401, env);
  }
  await resetThrottle(env, "throttle:login");

  const totpSecret = await env.ADMIN_KV.get(KV_TOTP_SECRET);
  const adminEmail = await env.ADMIN_KV.get(KV_ADMIN_EMAIL);
  const totpEnabled = !!totpSecret;
  let emailSent = false;
  let otpHash = null;

  if (adminEmail) {
    const otp = randomOtp6();
    otpHash = await sha256Hex(otp);
    try {
      emailSent = await sendOtpEmail(env, adminEmail, otp);
    } catch {
      emailSent = false;
    }
  }

  if (!totpEnabled && !emailSent) {
    return json(
      { error: "No 2FA method could be used (no authenticator secret, and email sending failed)." },
      500,
      env
    );
  }

  const challenge = await signToken(
    { purpose: "2fa", exp: Math.floor(Date.now() / 1000) + 300, otpHash },
    env.SESSION_SECRET
  );

  return json({ challenge, totpEnabled, emailSent }, 200, env);
}

async function handleVerify2fa(request, env) {
  const locked = await checkThrottle(env, "throttle:2fa");
  if (locked) return json({ error: `Too many attempts. Try again in about ${Math.ceil(locked / 60)} minute(s).` }, 429, env);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request body." }, 400, env);
  }
  const { challenge, code } = body;
  if (!challenge || !code) return json({ error: "Missing challenge or code." }, 400, env);

  const payload = await verifyToken(challenge, env.SESSION_SECRET);
  if (!payload || payload.purpose !== "2fa") {
    return json({ error: "That code has expired. Please log in again." }, 401, env);
  }

  const now = Math.floor(Date.now() / 1000);
  let matched = false;

  const totpSecret = await env.ADMIN_KV.get(KV_TOTP_SECRET);
  if (totpSecret) {
    matched = await verifyTotp(totpSecret, code, now);
  }
  if (!matched && payload.otpHash) {
    const candidateHash = await sha256Hex(String(code).trim());
    matched = candidateHash === payload.otpHash;
  }

  if (!matched) {
    await failThrottle(env, "throttle:2fa");
    return json({ error: "Incorrect code." }, 401, env);
  }
  await resetThrottle(env, "throttle:2fa");

  const token = await signToken({ purpose: "session", exp: Math.floor(Date.now() / 1000) + 7200 }, env.SESSION_SECRET);
  return json({ token }, 200, env);
}

async function handleChangePassword(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "Not logged in." }, 401, env);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request body." }, 400, env);
  }
  const current = String(body.currentPassword || "");
  const next = String(body.newPassword || "");

  const storedHash = await env.ADMIN_KV.get(KV_PASSWORD_HASH);
  const ok = storedHash && (await verifyPassword(current, storedHash));
  if (!ok) return json({ error: "Current password is incorrect." }, 401, env);
  if (next.length < 8) return json({ error: "New password must be at least 8 characters." }, 400, env);

  await env.ADMIN_KV.put(KV_PASSWORD_HASH, await hashPassword(next));
  return json({ success: true }, 200, env);
}

async function handleTotpRegenerate(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "Not logged in." }, 401, env);

  const secret = generateTotpSecret();
  await env.ADMIN_KV.put(KV_TOTP_SECRET, secret);
  return json({ totpSecret: secret }, 200, env);
}

async function handleTotpDisable(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "Not logged in." }, 401, env);

  const email = await env.ADMIN_KV.get(KV_ADMIN_EMAIL);
  if (!email) {
    return json({ error: "You need at least one 2FA method — add an email before turning off the authenticator app." }, 400, env);
  }
  await env.ADMIN_KV.delete(KV_TOTP_SECRET);
  return json({ success: true }, 200, env);
}

async function handleEmail2fa(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "Not logged in." }, 401, env);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request body." }, 400, env);
  }
  const email = String(body.email || "").trim();

  if (email && !isValidEmail(email)) return json({ error: "That email address doesn't look valid." }, 400, env);

  if (!email) {
    const totpSecret = await env.ADMIN_KV.get(KV_TOTP_SECRET);
    if (!totpSecret) {
      return json({ error: "You need at least one 2FA method — turn on the authenticator app before removing your email." }, 400, env);
    }
    await env.ADMIN_KV.delete(KV_ADMIN_EMAIL);
  } else {
    await env.ADMIN_KV.put(KV_ADMIN_EMAIL, email);
  }
  return json({ success: true }, 200, env);
}

// ============================================================
// Route handlers — catalog data
// ============================================================

async function handleGetData(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "Not logged in." }, 401, env);

  const [productsFile, categoriesFile, settingsFile] = await Promise.all([
    ghGetJSON(env, "products.json"),
    ghGetJSON(env, "categories.json"),
    ghGetJSON(env, "settings.json"),
  ]);

  return json(
    {
      products: productsFile.data || [],
      categories: categoriesFile.data || [],
      settings: settingsFile.data || {},
      shas: { products: productsFile.sha, categories: categoriesFile.sha, settings: settingsFile.sha },
    },
    200,
    env
  );
}

function validateCatalog(categories, products) {
  if (!Array.isArray(categories)) return "categories must be an array.";
  if (!Array.isArray(products)) return "products must be an array.";

  const catIds = new Set();
  const byId = new Map();
  for (const c of categories) {
    if (!c || !c.id || !c.name) return "Every category needs an id and a name.";
    if (catIds.has(c.id)) return `Duplicate category id "${c.id}".`;
    catIds.add(c.id);
    byId.set(c.id, c);
  }

  // Sub-categories: at most one level deep. A category's parentId, if set,
  // must point at an existing category that is itself top-level.
  const parentIds = new Set(); // ids that have at least one child (so products can't attach directly to them)
  for (const c of categories) {
    if (c.parentId == null || c.parentId === "") continue;
    const parent = byId.get(c.parentId);
    if (!parent) {
      return `Category "${c.name}" refers to a parent category that doesn't exist — its parent may have been deleted while it still had subcategories.`;
    }
    if (parent.parentId) {
      return `Category "${c.name}" can't be nested under "${parent.name}" — subcategories can only be one level deep.`;
    }
    parentIds.add(c.parentId);
  }

  const skus = new Set();
  for (const p of products) {
    if (!p || !p.id || !p.name) return "Every product needs an id and a name.";
    if (!catIds.has(p.categoryId)) {
      return `Product "${p.name}" refers to a category that doesn't exist — move or delete it first, or its category was deleted while it still had products.`;
    }
    if (parentIds.has(p.categoryId)) {
      const cat = byId.get(p.categoryId);
      return `Product "${p.name}" is assigned directly to "${cat.name}", which has subcategories — assign it to one of those subcategories instead.`;
    }
    if (!Array.isArray(p.variants) || p.variants.length === 0) {
      return `Product "${p.name}" needs at least one SKU (colour/size variant).`;
    }
    for (const v of p.variants) {
      if (!v || !v.sku) return `Product "${p.name}" has a variant with no SKU.`;
      const skuKey = String(v.sku).toLowerCase();
      if (skus.has(skuKey)) return `SKU "${v.sku}" is used more than once.`;
      skus.add(skuKey);
    }
  }
  return null;
}

async function handlePublish(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "Not logged in." }, 401, env);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request body." }, 400, env);
  }

  const { products, categories, settings, shas, photos } = body;
  const finalShas = { ...(shas || {}) };

  try {
    // Validate the full catalog together (categories + products must be
    // internally consistent), whichever of the two changed this time.
    if (products !== undefined || categories !== undefined) {
      // Need both halves to validate cross-references; fetch whichever
      // side wasn't sent so validation still sees the true current state.
      let cats = categories;
      let prods = products;
      if (cats === undefined) cats = (await ghGetJSON(env, "categories.json")).data || [];
      if (prods === undefined) prods = (await ghGetJSON(env, "products.json")).data || [];
      const err = validateCatalog(cats, prods);
      if (err) return json({ error: err }, 400, env);
    }

    // Upload any new/changed photos first.
    if (photos && typeof photos === "object") {
      for (const [path, base64] of Object.entries(photos)) {
        if (!path || !base64) continue;
        const existing = await ghGetFile(env, path).catch(() => null);
        await ghPutFile(env, path, base64, `Update photo: ${path}`, existing ? existing.sha : undefined);
      }
    }

    if (categories !== undefined) {
      finalShas.categories = await ghPutJSON(env, "categories.json", categories, "Update categories via admin panel", shas && shas.categories);
    }
    if (products !== undefined) {
      finalShas.products = await ghPutJSON(env, "products.json", products, "Update product catalog via admin panel", shas && shas.products);
    }
    if (settings !== undefined) {
      finalShas.settings = await ghPutJSON(env, "settings.json", settings, "Update site settings via admin panel", shas && shas.settings);
    }

    return json({ success: true, shas: finalShas }, 200, env);
  } catch (err) {
    if (err.status === 409) {
      return json(
        { error: "This changed elsewhere since you loaded it. Refresh and re-apply your changes." },
        409,
        env
      );
    }
    return json({ error: "Publish failed: " + err.message }, 500, env);
  }
}

// ============================================================
// Entry point
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({ ok: true }, 200, env);
      }
      if (url.pathname === "/api/install-status" && request.method === "GET") {
        return await handleInstallStatus(request, env);
      }
      if (url.pathname === "/api/install" && request.method === "POST") {
        return await handleInstall(request, env);
      }
      if (url.pathname === "/api/login" && request.method === "POST") {
        return await handleLogin(request, env);
      }
      if (url.pathname === "/api/verify-2fa" && request.method === "POST") {
        return await handleVerify2fa(request, env);
      }
      if (url.pathname === "/api/data" && request.method === "GET") {
        return await handleGetData(request, env);
      }
      if (url.pathname === "/api/publish" && request.method === "POST") {
        return await handlePublish(request, env);
      }
      if (url.pathname === "/api/change-password" && request.method === "POST") {
        return await handleChangePassword(request, env);
      }
      if (url.pathname === "/api/totp/regenerate" && request.method === "POST") {
        return await handleTotpRegenerate(request, env);
      }
      if (url.pathname === "/api/totp/disable" && request.method === "POST") {
        return await handleTotpDisable(request, env);
      }
      if (url.pathname === "/api/email-2fa" && request.method === "POST") {
        return await handleEmail2fa(request, env);
      }
      return json({ error: "Not found." }, 404, env);
    } catch (err) {
      return json({ error: "Server error: " + (err && err.message ? err.message : String(err)) }, 500, env);
    }
  },
};
