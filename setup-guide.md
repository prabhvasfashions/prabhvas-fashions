# Prabhvas Fashions — v2 setup &amp; migration guide

This is a substantial upgrade to the same free architecture you already had running (GitHub Pages + a Cloudflare Worker) — no PHP, no paid hosting, no database server. What's new: a full admin panel with a category maker, a proper colour/size SKU editor with per-SKU photos, a settings page, self-service password/2FA changes, and login throttling.

## What changed under the hood

- **Categories, products, and site settings are now three separate files** — `categories.json`, `products.json` (products now nest their SKUs/variants instead of one flat row per colour), and `settings.json` (site name, WhatsApp number, currency, tagline, Instagram link). All three are managed entirely from the admin panel now.
- **Your password and authenticator-app secret now live in Cloudflare Workers KV** instead of Worker "secrets." KV is a small key-value store the Worker can read *and write* while running — that's what makes self-service password changes and 2FA management possible. Secrets (the old way) can only be changed by you, by hand, in the Cloudflare dashboard.
- **A one-time setup step inside the admin panel itself replaces `hash-generator.html`.** You'll type your password once, directly into the admin page, over a normal secure HTTPS connection — the Worker hashes it immediately and it's never stored or logged in plain text. This is the same trust model every ordinary website login uses; it's simpler than the old offline-tool step without giving up any real security.
- **Login and 2FA attempts are now throttled** — 5 wrong tries locks it for 5 minutes, tracked in the same KV store.
- A note on CSRF: the admin panel talks to the Worker using a bearer token in an `Authorization` header (not a cookie), so classic CSRF attacks — which rely on a browser automatically attaching your cookies to a forged cross-site request — don't apply here the same way a traditional form-based site needs protecting against. There's nothing extra you need to configure for this.

## 1. Add a KV namespace to your Worker

In the Cloudflare dashboard: **Workers &amp; Pages → your Worker → Settings → Bindings → Add → KV Namespace**.

1. If you don't already have one, create a new KV namespace (e.g. name it `prabhvas-admin-kv`).
2. Bind it to your Worker with the variable name **`ADMIN_KV`** (this exact name — the code looks for it).
3. Save.

## 2. Replace the Worker code

Open your Worker → **Edit code**, select all the existing code, delete it, and paste in the new `worker.js` from this zip. Click **Deploy**.

## 3. Clean up old secrets (optional but recommended)

Your credentials now live in KV, not in Worker secrets, so these old secrets are no longer read by the code and can be removed from **Settings → Variables and secrets**:

- `ADMIN_PASSWORD_HASH`
- `TOTP_SECRET`
- `EMAILJS_TO_EMAIL`

Keep these — they're still used:

- `SESSION_SECRET`, `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `ALLOWED_ORIGIN`
- `EMAILJS_SERVICE_ID`, `EMAILJS_TEMPLATE_ID`, `EMAILJS_PUBLIC_KEY`, `EMAILJS_PRIVATE_KEY` (only if you want the emailed-code 2FA channel)

## 4. Upload the new site files to GitHub

Upload everything under `site/` in this zip to your GitHub Pages repo, replacing the old files: `index.html`, `admin.html`, `categories.json`, `products.json`, `settings.json`. Your old flat `products.json` is replaced by the new nested structure, already seeded with your existing Palazzo product so nothing is lost.

## 5. Run the one-time setup

Visit `your-site.github.io/admin.html`. Since your Worker's KV store is empty, you'll see **"Set up your admin account"** instead of the sign-in screen. Set a password (8+ characters), turn on the authenticator app and/or add an email for 2FA, and submit. If you enabled the authenticator app, you'll see a key shown once — add it to your authenticator app (Google Authenticator, Authy, etc.) via "enter a setup key manually" right away, since it won't be shown again.

You'll then land on the normal sign-in screen — sign in with your new password and code.

## 6. Using the admin panel

- **Dashboard** — a quick summary: total products, how many are live, total SKUs, sold-out SKUs, and categories.
- **Products** — the full list, with edit and delete. "+ Add Product" opens the editor: product name, category, description, base price, and a repeatable table of SKUs — add as many colour/size rows as you need, each with its own stock count, an optional price override, and its own photo.
- **Categories** — add, rename, and reorder categories, and now nest one level of subcategories under a main category. Say you sell "Short Tops" in a few prints — make "Short Tops" a category, then add "Frozo Print," "Embroidery Neck," and "Rose Pattern" as subcategories with "Short Tops" chosen as their parent. On the live site, clicking "Short Tops" shows those prints as tabs, with the matching products underneath each tab (a subcategory with no products yet just doesn't get a tab, so nothing empty ever shows). Products always go on the most specific category — a subcategory if the parent has any, otherwise the category itself — the product editor's category list groups subcategories under their parent so this is easy to get right. Deleting a category is blocked with a friendly message if it still has subcategories or products underneath it — clear those out (or move them) first. Subcategories can only go one level deep — you can't put a subcategory under another subcategory.
- **Settings** — site name, tagline, WhatsApp number, currency, and Instagram link (these stage like everything else — click Publish to go live), plus your account security: change your password anytime, regenerate or turn off your authenticator key, and set or remove the email used for emailed codes. Security changes take effect immediately; they don't need Publish.

Everything on the Products/Categories/Settings tabs *stages* your changes — nothing goes live until you click **Publish Changes**, which commits the updated files to your GitHub repo (and uploads any new photos) in one step. Your live site picks up the change within about a minute.

## Notes

- **Emailed 2FA codes** need the EmailJS secrets above configured, same as before. If you skip that, just use the authenticator app.
- **Photos** you upload get committed as real files into your GitHub repo (same as before) — there's no separate file storage to manage.
- **Locked out?** Wrong password or code 5 times locks that channel for 5 minutes automatically. If you're ever fully locked out of both password and 2FA, you'd need to clear the relevant KV keys directly in the Cloudflare dashboard (KV → your namespace) — delete `admin_password_hash` to allow running the one-time setup again from scratch.
