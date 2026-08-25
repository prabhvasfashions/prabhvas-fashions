# Prabhvas Fashions — v2 setup &amp; migration guide

This is a substantial upgrade to the same free architecture you already had running (GitHub Pages + a Cloudflare Worker) — no PHP, no paid hosting, no database server. What's new: a full admin panel with a category maker, a proper colour/size SKU editor with per-SKU photos, a settings page, self-service password/2FA changes, and login throttling.

## What changed under the hood

- **Categories, products, and site settings are now three separate files** — `categories.json`, `products.json` (products now nest their SKUs/variants instead of one flat row per colour), and `settings.json` (site name, WhatsApp number, currency, tagline, contact email, and social links). All three are managed entirely from the admin panel now.
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

**If this isn't your first time setting this up — your site already has real products and categories in it** — only replace the code files: `index.html`, `admin.html`, and (after redeploying the Worker) nothing else needs touching by hand. Leave your live `categories.json`, `products.json`, and `settings.json` alone; they hold your real catalog and settings. Any new settings (like Contact email or hero banner photos) are added through the admin panel's Settings tab and saved with Publish, the same as everything else — never by re-uploading a fresh `settings.json` over your real one. A new `reviews.json` file isn't something you need to upload either — the Worker creates it automatically the first time you approve a review.

**A previous round added files for the "install as an app" feature (see that section below):** `manifest.webmanifest`, `admin-manifest.webmanifest`, `sw.js`, `admin-sw.js`, and ten new icon images under `assets/` (`icon-192.png`, `icon-512.png`, `icon-192-maskable.png`, `icon-512-maskable.png`, `icon-180.png`, and the same five with an `admin-` prefix). These are all new additions, not replacements, so there's nothing to worry about overwriting.

**This round adds one more new file:** `assets/Prabhvas-Fashions-Admin-Guide.pdf` — the downloadable PDF version of the Admin Guide, linked from the new FAQ tab. Again, a new addition, nothing to overwrite. `index.html` and `admin.html` are both updated again this round too (a header/navigation layout tweak, a "Hi, {name}" greeting, a footer "Mobile App" link, and the new FAQ tab).

## 5. Run the one-time setup

Visit `your-site.github.io/admin.html`. Since your Worker's KV store is empty, you'll see **"Set up your admin account"** instead of the sign-in screen. Set a password (8+ characters), turn on the authenticator app and/or add an email for 2FA, and submit. If you enabled the authenticator app, you'll see a key shown once — add it to your authenticator app (Google Authenticator, Authy, etc.) via "enter a setup key manually" right away, since it won't be shown again.

You'll then land on the normal sign-in screen — sign in with your new password and code.

## 6. Using the admin panel

- **Dashboard** — a quick summary: total products, how many are live, total SKUs, sold-out SKUs, and categories.
- **Products** — the full list, with edit and delete. "+ Add Product" opens the editor: product name, category, description, base price, and a repeatable table of SKUs — add as many colour/size rows as you need, each with its own stock count, an optional price override, and its own photo.
- **Categories** — add, rename, and reorder categories, and now nest one level of subcategories under a main category. Say you sell "Short Tops" in a few prints — make "Short Tops" a category, then add "Frozo Print," "Embroidery Neck," and "Rose Pattern" as subcategories with "Short Tops" chosen as their parent. On the live site, your main categories ("Short Tops," "Palazzos," etc.) now appear as tabs at the top — clicking one shows only that category's products, instead of the whole page scrolling past every category one after another. If that category has subcategories, a second row of tabs appears just below it for those (Frozo Print, Embroidery Neck, etc.), with the matching products underneath — a subcategory with no products yet just doesn't get a tab, so nothing empty ever shows. Products always go on the most specific category — a subcategory if the parent has any, otherwise the category itself — the product editor's category list groups subcategories under their parent so this is easy to get right. Deleting a category is blocked with a friendly message if it still has subcategories or products underneath it — clear those out (or move them) first. Subcategories can only go one level deep — you can't put a subcategory under another subcategory.
- **Settings** — site name, tagline, WhatsApp number, currency, contact email, social links (Instagram, Facebook, TikTok, Snapchat, Moj), the hero banner photos/rotation speed, delivery zones, self-collection points, delivery time slots, and the customer-capture (entry gate) toggle — plus your account security: change your password anytime, regenerate or turn off your authenticator key, and set or remove the email used for emailed codes. Security changes take effect immediately; they don't need Publish.

Products and Categories still work the way they always have: changes *stage* first, and nothing goes live until you click **Publish Changes**, which commits everything staged to your GitHub repo (and uploads any new photos) in one step.

**Settings now publishes differently.** Each card on the Settings tab — Site details, Hero banner photos, Delivery zones, Collection points, Delivery slots, and Customer capture — has its own **"Save &amp; Publish"** button right underneath it. Clicking it saves and publishes *just that card* immediately, without needing (or affecting) the main Publish Changes button. This means if you only want to, say, turn the entry gate on, you click that one section's own button and it's live within about a minute — you don't need to also publish your Products/Categories work in progress, and vice versa. The main **Publish Changes** button at the top still exists and still works exactly as before for Products and Categories.

## Storefront browsing: sidebar + hero

- **Category sidebar** — alongside the tabs at the top, there's now also a vertical category list on the left side of the collection (a slide-in drawer with a "Browse Categories" button on phones). Categories with subcategories get an arrow you can click to expand/collapse their list without changing what's showing; clicking the category or subcategory name itself switches the page to it. Both the sidebar and the top tabs always stay in sync with each other.
- **Hero banner** — the top banner now spans the full width of the browser edge-to-edge (no side margins, no rounded corners), and is noticeably taller, with your logo, headline, tagline, and buttons layered on top of a photo. The logo sits inside a white circular badge, sized generously so it stays clearly visible against any photo without needing a bigger banner, and the photo itself is softened (dulled and lightly blurred) so the text stays easy to read while the photo still reads as colourful. If your live site still shows the older, narrower rounded version after you upload these files, do a hard refresh (Ctrl/Cmd+Shift+R) — browsers and GitHub Pages both cache aggressively, so the old version can stick around in a cache for a bit even after the new file is live.
- **Top navigation logo** — the small logo mark in the top navigation bar (as opposed to the large one in the hero banner) is now 125% of its previous size, and the "Prabhvas Fashions" text next to it matches the logo's own gold/bronze colour and lettering style (uppercase, same serif typeface), so the wordmark and the icon read as one consistent brand unit instead of two different styles side by side.

## Hero banner: rotating photos

The hero banner can rotate through up to 6 photos, changing to the next one (with a soft crossfade) — go to the admin panel's **Settings** tab → **Hero banner photos**. Photo 1 is required — it's what shows if you don't add anything else, and it's the same photo the banner has always used (`assets/hero-photo.jpg`). Add Photos 2 through 6 to turn on rotation; each is a plain upload, no filenames or coding needed, and it stages like everything else — click Publish to go live. Photos you haven't added are just skipped, so it's fine to add one or two now and the rest later, or never add more at all.

Just below the photo slots, a **"Change photo every (seconds)"** field controls how long each photo stays up before crossfading to the next — it defaults to 10 seconds and only matters once you've added a second photo. It has its own **Save &amp; Publish** button right there in the Hero banner photos card — use it to push this section live independently of anything else you're working on.

We don't have any additional photos of your store or products to suggest on our own — the rotation is ready to use whenever you have more photos to add (product shots, in-store photos, seasonal looks, etc.). If you'd like help finding stock photography to fill the extra slots in the meantime, let us know and we can search for some options for you to choose from — we wouldn't publish anything to your live site without you picking it first.

## Contact Us popup

There's now a "Contact Us" link in the top navigation and the footer. Clicking it opens a small popup with two ways to reach you:

- **Message us on WhatsApp** — always shown, opens a chat pre-filled with a friendly "I have a suggestion / question" message, sent to your WhatsApp number from Settings.
- **Email us** — only shown if you've set a **Contact email** in the admin panel's Settings tab (new field, next to WhatsApp number and Instagram URL). Leave it blank if you don't want the email option to appear. It opens the visitor's own email app with your address and a suggested subject line already filled in.

## Customer reviews

Shoppers can leave a star rating and review on any product — click the star rating under a product (or "Be the first to review" if it has none) to open the Reviews popup, which shows existing reviews and a form to add a new one (name required; email and phone optional, and used only so you can follow up with that customer — they're never shown publicly). A submitted review does **not** appear on the site right away.

In the admin panel's new **Reviews** tab (with a badge showing how many are waiting), you'll see every pending review with its rating, comment, and product, plus that customer's email/phone if they gave one. **Approve** publishes it to the live site immediately — no need to click Publish separately, this happens right away, the same way password and 2FA changes do. **Reject** discards it. You can also delete an already-published review later from the same tab if you ever need to. Product cards and the product popup show a star rating and review count once a product has at least one approved review.

To keep spam down, review submissions are rate-limited automatically and include a basic bot trap — nothing you need to configure.

## General feedback

Next to "Contact Us" in the navigation and footer, there's now a separate **"Feedback"** button — for shoppers who want to leave general feedback about Prabhvas Fashions as a whole, not tied to any one product (your per-product star ratings and reviews are unchanged and still work exactly as described above). It opens the same kind of popup as product reviews — a star rating plus name (required), email and phone (optional), and comments — and goes through the exact same admin approval flow: it lands in the admin panel's **Reviews** tab, labelled "General feedback (not product-specific)," where you **Approve** to publish it or **Reject** to discard it, same as any product review. This mirrors the way Amazon separates seller/store feedback from individual product reviews.

## Social links

Alongside Instagram, the Settings tab now has fields for **Facebook, TikTok, Snapchat, and Moj** URLs, all optional. Fill in whichever ones apply to your store and click Publish — a matching icon/link appears in the site footer. Leave any of them blank and that one simply doesn't show up, same as Instagram already worked.

## Shopping cart

Shoppers can now order several items in one go, the way they would on any online store — add things to a cart as they browse, then check out once, instead of placing a separate WhatsApp order per item.

- **Quick-add** — every product card has a small **"+"** button. For a product with only one option (or only one size/colour actually in stock), tapping it adds that item straight to the cart with no extra taps. For a product with a real choice to make, it opens Quick View instead, since the site can't guess which variant the shopper wants.
- **Quick View** — opening a product (by tapping the card itself) now shows a quantity stepper and an **"Add to Cart"** button in place of the old single-item "Order on WhatsApp" link. A shopper can pick a variant, set a quantity, and add it — Quick View shows a brief "Added ✓" confirmation and then closes itself automatically a moment later, dropping the shopper back on the collection to keep browsing, rather than leaving them to close it by hand.
- **The cart** — a cart icon in the top navigation shows a live count of items added. Opening it lists every line (photo, variant, quantity, price), with +/− controls and a remove option per line, plus a running subtotal.
- **Checkout** — the delivery/self-collection step your shoppers see (described below) now happens once, from the cart, covering the whole order rather than one item at a time. Submitting opens a single WhatsApp message listing every item, the delivery or collection details, and the total — one hand-off for the whole basket, exactly like an Amazon-style cart-then-checkout flow.

The cart is intentionally **session-only** — it does not persist between visits. If a shopper closes the tab or comes back later, they start with an empty cart, the same way it would reset if they walked out of a physical shop. If saving the order to the admin panel ever fails (e.g. a connection hiccup), the WhatsApp message still opens — nothing blocks the shopper from reaching you.

## Delivery &amp; self-collection orders

Shoppers choose **delivery** or **self-collection** once, at cart checkout, covering every item in the cart. This step only appears once you've configured at least one delivery zone or one collection point in Settings (see below) — until then, checkout asks only for name and phone, exactly like the site always worked, with no changes.

- **Delivery** — the shopper picks their area from the zones you've configured, sees the delivery charge for that area update live, enters their address, taps "Use my current location" to attach their exact GPS coordinates (their browser will ask permission), picks a preferred date and time slot from the ones you've set up, and enters their name and phone.
- **Self-collection** — the shopper picks one of your collection points (shown with address, hours, and a "View on map" link) and enters their name and phone. No delivery charge applies.

Either way, the order total shown includes any delivery charge, and checking out both records the order in your admin panel (see **Orders**, below) and opens WhatsApp with a pre-filled message summarising everything — every item and its quantity, the address or collection point, date/slot, and total — exactly like the WhatsApp link always worked, just covering the whole cart at once.

Payment itself is unchanged — there's no online payment gateway added. The total shown (including delivery charge) is for your reference when you follow up with the shopper on WhatsApp, same as before.

### Delivery zones &amp; pricing

In **Settings → Delivery zones &amp; pricing**, add the areas you deliver to, each with an emirate, a delivery charge, an optional "free above" order amount, and an available/unavailable toggle (useful for temporarily pausing an area without deleting it). You can add zones two ways:

- **Manual entry** — click "+ Add zone" and fill in the row.
- **CSV/Excel upload** — click "Upload a file" and choose a `.csv` (or `.xlsx`/`.xls`) file. The uploader looks for columns named (case-insensitive, a few common variants accepted): **Area**, **Emirate**, **Charge**, **Free above**, **Available** (yes/no). Uploading replaces the zones currently staged — review the table afterwards and click Publish Changes to go live, same as everything else in the admin panel. `.xlsx`/`.xls` uploads need an internet connection to load the spreadsheet reader; if that's ever unavailable, save your file as `.csv` instead and it'll work offline.

Only zones marked "Available" are offered to shoppers on the storefront.

### Self-collection points

In **Settings → Self-collection points**, add one or more pickup locations — name, address, hours, and (optional but recommended) GPS coordinates, either typed in directly or captured with the "Use my current location" button while you're standing at that location. Coordinates are what powers the "View on map" link shoppers see. Add as many as you have — a single shop, or several branches.

### Delivery time slots

In **Settings → Delivery time slots**, define the fixed time windows shoppers can choose from when scheduling a delivery (e.g. "9am–12pm," "12pm–4pm," "4pm–8pm"). These are the same slots for every zone; add, relabel, or remove them as needed.

### Orders

A new **Orders** tab in the admin panel (with a badge showing new orders) lists every order placed through the storefront's delivery/collection flow — customer contact details, a thumbnail photo and description per item ordered (handy for picking/packing), the delivery address and GPS pin or collection point, requested date/slot, and total. Every order gets a short order number (**#1, #2, #3, ...**) so you and a customer can refer to the same order without reading out a long id. Unlike your product catalog, orders are **not** published to your public GitHub repo — they're kept privately in your Worker's KV store, since they contain customer names, phone numbers, and addresses.

Each order card is tinted by its status — amber for a brand-new order needing attention, blue while it's confirmed/booked/in transit, green once delivered or collected, red (and slightly faded) if cancelled — so the whole list is scannable at a glance without reading every line. The status itself is one you update by hand from the same tab, modelled on how a courier like Aramex tracks a shipment — **new → confirmed → booked → in transit → delivered/collected → cancelled** — so you (or whoever's managing fulfilment) always has a clear, familiar picture of where an order stands, whether you're delivering it yourself, using a local driver, or booking it with any courier company. There's no live courier API wired in — moving an order forward is just picking the next status from the dropdown, and it takes effect immediately, no Publish needed. If down the line you do want a specific courier's live rates/booking/tracking connected automatically, that's a separate integration we can build once you have an account with them — this Orders tab will keep working the same way either way.

### Proforma invoice (sent for the customer to accept)

Each order card has a **"Send Proforma Invoice"** button. Clicking it prepares a PDF invoice for that order (itemised costing, delivery/collection details, total) and opens WhatsApp with a message to that customer, pre-filled with a link to view/download the PDF and a second link they can tap to formally accept the order — you just hit Send in WhatsApp, exactly like every other WhatsApp hand-off on this site.

This does **not** require a WhatsApp Business API account or any paid messaging setup — it uses the same "open a pre-filled chat, you tap Send" pattern as the rest of the site, just with an invoice PDF and an accept link included in the message. Sending it from whichever WhatsApp account is signed in on the device you click from is what makes it "go out through" your business number in practice, so do this from the device/browser where your shop's WhatsApp is logged in.

When the customer taps the accept link, they land on a simple "Thank you" confirmation page, and back in your admin panel that order gets a green **"✓ Accepted"** badge and automatically moves from "New" to "Confirmed" status — no need to ask them to reply and update it yourself. The invoice PDF itself is built directly by the Worker (no third-party PDF service), using a standard font that covers English/Latin text well; if you ever need a customer's name or address to display correctly in Arabic script on the invoice PDF, let us know — that needs a bit more work to support properly.

## Track Order — self-service order status for customers

Customers no longer need to message you to ask "where's my order?" A **"Track Order"** link now sits in the top navigation and the footer, next to Contact Us and Feedback. Tapping it opens a small popup asking for the mobile number the order was placed with; submitting it shows every order under that number — order number, current status (New, Confirmed, Booked with courier, In transit, Delivered, Collected, or Cancelled — the exact same stages you set from the Orders tab), what was ordered, the delivery area or collection point, and the total. If a shopper already went through the entry gate or has ordered from this browser before, the number is pre-filled for them automatically.

A couple of deliberate choices worth knowing about:

- **No login or order number needed** — just the phone number, so it's genuinely self-service. The trade-off is that a phone number alone isn't a strong secret: anyone who knows (or guesses) a customer's number could look up their orders. To limit that, the lookup is rate-limited per visitor and deliberately shows a **trimmed** view — no exact street address, no GPS pin, and no email — just enough to answer "where's my order," not a customer's full details.
- **Matches however the number was typed** — the same phone-matching the rest of the site already uses, so "0501234567," "+971501234567," and "971501234567" all find the same orders regardless of which format a customer types.
- If no orders match, they see a friendly message suggesting they double-check the number or message you on WhatsApp directly — nothing that looks like an error.

There's nothing to configure for this — it works automatically for every order already coming through the site, past and present.

## Install as an app (Android, iPhone/iPad, and desktop)

Both the storefront and the admin panel can now be installed like a regular app, with their own home-screen icon, and opened full-screen without any browser address bar around them. Under the hood this is a "PWA" (progressive web app) — no app-store listing or review process involved, it installs straight from the website.

These are deliberately set up as **two separate, independently-installable apps** — one for your customers (the storefront, with your gold/ivory logo) and one for you and your staff (the admin panel, with a dark icon so it's easy to tell apart on a home screen at a glance). A shopper installing the storefront never sees or is offered the admin app, and vice versa. If you'd rather not offer the admin one as an installable app, let me know and it can be dropped — nothing about the storefront depends on it.

**For customers — installing the storefront:**

- **Android (Chrome):** after visiting the site, Chrome shows an "Install app" banner, or the same option is under the **⋮** menu → **Install app** / **Add to Home screen**.
- **iPhone/iPad (Safari):** iOS doesn't offer an automatic install prompt — tap the **Share** icon, then **Add to Home Screen**.
- **Desktop (Chrome/Edge):** a small install icon appears in the address bar, or it's under the browser's **⋮**/**…** menu.

**For you — installing the admin panel:** exactly the same steps, just starting from your `admin.html` link instead — or use the dedicated **Install Admin App** button described below, which is the easiest route. Because it's a separate app from the storefront, you can have both installed side by side.

Once installed, the app opens in its own window with no browser chrome, works from a home-screen icon like any other app, and still always talks to the live site for orders, products, and settings — nothing about how you manage the shop day-to-day changes. A lightweight "offline shell" is cached purely so the app has something to show if your connection briefly drops; it never shows stale orders or catalog data, since every screen still refreshes from the live Worker on every visit.

There's nothing to configure for this either — no toggle, no publish step. It works automatically once the new files below are live on GitHub Pages.

**A "Mobile App" link for customers:** the storefront's footer now has a **Mobile App** link, right alongside Track Order, Contact Us, and Feedback. Tapping it opens a small popup that either offers a one-tap **Install Now** button (Android/Chrome/desktop, when the browser supports it) or shows the same Android/iPhone/Desktop instructions above — so customers don't need to already know how "add to home screen" works on their phone to find it.

**An "Install Admin App" button for you:** the new FAQ tab in the admin panel (see below) has the same one-tap install button for the admin panel itself, plus a manual-steps fallback.

## FAQ &amp; Admin Guide tab (in the admin panel)

The admin panel now has its own **FAQ** tab in the navigation, alongside Dashboard, Products, Categories, and so on. It carries the full contents of the Admin Guide — over 20 expandable questions covering everything from signing in to publishing, Settings, Orders, Customers, Reviews, Track Order, and installing as an app — organised by topic, right inside the app itself, so you (or anyone helping you run the shop) never has to go dig up a separate document.

At the top of that tab, a **Downloads** card has two things:

- **Download Admin Guide (PDF)** — the same guide as a PDF you can save, print, or share with staff who'd rather read it outside the browser.
- **Install Admin App** — the one-tap install button described above, with a manual-steps fallback underneath it.

Nothing here needs configuring or publishing — it's static reference content that ships with the code files.

## Customer capture (entry gate) &amp; the Customers list

Every order already captures a customer's name and phone number, but you can optionally build a fuller list of everyone who visits the site — not just people who order.

In **Settings → Customer capture**, a toggle labelled **"Require visitor details before browsing (entry gate)"** switches the gate on or off. Tick it, click that card's own **Save &amp; Publish** button, and every visitor sees a full-screen welcome form (name and phone required; email and area optional) before they can browse the storefront at all — live within about a minute. This is a deliberate trade-off — some casual visitors will leave rather than fill in a form — so it's entirely your call whether the larger customer list is worth that, and you can switch it back off at any time the same way.

A few details on how it behaves:

- Each visitor is deduplicated by phone number (formatted differently — with or without a leading 0, with or without the UAE country code — still resolves to the same person), so submitting the form again doesn't create a duplicate entry, it just updates their record and bumps their visit count.
- Once a visitor submits the form, they're greeted with a short personalised welcome message before continuing — a small "start browsing" moment rather than a form that just vanishes.
- The gate reappears once per browser session (e.g. a new tab or after the browser fully restarts), but a returning visitor is greeted by name and has their phone number pre-filled, so it only takes one tap to continue.
- Whatever name and phone a visitor provides at the gate also pre-fills the name/phone fields at cart checkout, so they're not asked twice.
- Once a visitor's name is known — from the gate, or simply from placing an order, even with the gate switched off — the storefront's top banner greets them by first name ("Hi, Fatima") next to the logo on their next visit. Purely cosmetic, no configuration needed, and it never shows for a first-time visitor whose name isn't known yet.

Everyone captured this way — along with anyone who's simply placed an order — shows up in a new **Customers** tab in the admin panel: name, phone, email, area, how many times they've visited, and first/last-seen dates. A **Refresh** button pulls the latest list, and an **Export CSV** button downloads it as a spreadsheet you can import into WhatsApp Business, Mailchimp, or wherever else you run outreach from. Like Orders, this list is kept privately in your Worker's KV store — it isn't published to your public GitHub repo.

If you're upgrading a shop that already had orders coming in before this Customers list existed, those older orders won't automatically appear — click **Import from past orders** once on the Customers tab to pull them in. It's safe to click more than once; it only adds people who aren't already on the list and never touches an existing person's visit count.

## Notes

- **Emailed 2FA codes** need the EmailJS secrets above configured, same as before. If you skip that, just use the authenticator app.
- **Photos** you upload get committed as real files into your GitHub repo (same as before) — there's no separate file storage to manage.
- **Locked out?** Wrong password or code 5 times locks that channel for 5 minutes automatically. If you're ever fully locked out of both password and 2FA, you'd need to clear the relevant KV keys directly in the Cloudflare dashboard (KV → your namespace) — delete `admin_password_hash` to allow running the one-time setup again from scratch.
