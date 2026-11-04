# Dastarkhwan — Pakistani Kitchen

A mobile-first restaurant storefront with an authenticated admin dashboard, editable menu, shared server-side order inbox, and optional WhatsApp handoff.

## Run locally

Requires Node.js 20 or newer. No packages need to be installed.

1. Open a terminal in this folder.
2. Set up the private admin password once:
   - PowerShell: `node .\setup-admin.js`
   - Enter and confirm a password of at least 12 characters. Password input is hidden. Only a salted scrypt hash is stored.
3. Start the website: `node .\server.js` or `npm.cmd start`.
4. Open the customer site at `http://localhost:4173` and the admin dashboard at `http://localhost:4173/admin.html`.
5. In **Restaurant details** in the dashboard, enter the restaurant name and WhatsApp number in international format (for example, `+923001234567`).

Customers' orders are stored in the shared server-side inbox. After an order is saved, the customer may open a prefilled WhatsApp message; they must press **Send** in WhatsApp to notify the restaurant. Prices are calculated from the server menu, not trusted from the customer's browser. Online payments are not included.

## Admin dashboard

- Add, edit, hide, or delete dishes and update prices.
- Upload JPG, PNG, or WebP menu images up to 2 MB.
- Review customer contact/delivery details, change order status, open WhatsApp to contact a customer, or delete order records.
- Admin routes require a password and a same-origin session with CSRF protection. Login attempts are rate-limited.

## Data, privacy, and backups

The server stores its menu, WhatsApp configuration, and order records in `data/state.json`; the password hash is in `data/admin.json`, and uploaded images are in `data/uploads/`. The `data/` directory is excluded from Git. Back it up securely and restrict server access. Deleting an order in the dashboard permanently removes its customer contact details from the active order store.

The customer privacy page is a starter notice, not legal advice. Before accepting real customer details, the restaurant owner must review it, supply correct business/contact details, and set a retention and backup policy that complies with local rules. Customers must agree to the notice before submitting an order. Do not collect card details through this app.

The current restaurant name, menu, descriptions, prices, and photos are demo content. The owner must replace and approve them. Stock photos are illustrative and may differ from actual dishes. Use only photos the restaurant owns or is authorized to use.

## Deploy to Render

The repository includes `render.yaml` for a free Node.js web service in Singapore. Set a private `ADMIN_PASSWORD` environment variable in Render (at least 12 characters); the app creates the password hash on startup, so a shell is not required. Never put the password in GitHub or send it in chat.

1. Push the latest project files, including `render.yaml`, to GitHub.
2. In Render, choose **New → Blueprint**, connect GitHub, and select this repository. Confirm that the service plan is **Free** before creating it.
3. In the service's **Environment** settings, add `ADMIN_PASSWORD` with a strong password of at least 12 characters. Save the setting and allow Render to deploy.
4. Open the Render service URL and sign in at `/admin.html`. Configure the restaurant details and review the privacy notice.
5. Test the customer site and admin dashboard with sample orders only.

**Free service limitation:** Render Free services have no persistent disk and spin down when idle. Local files—including orders, menu edits, and uploads—can disappear when the service spins down, restarts, or redeploys, so the app may return to its initial demo state. The admin password is recreated from the private environment variable when the service starts. Do not use this free setup for real customer orders. For reliable order storage, upgrade to a paid service with a persistent disk mounted at `/var/data`, set `DATA_DIR=/var/data`, and keep only one app instance. Never commit `data/` or share customer records. A custom domain is optional; Render provides an HTTPS URL.

This JSON-file store is appropriate for a small, single-instance pilot. Before scaling or running high-volume orders, move data to a managed database and use managed object storage for uploads. Test the live hosting setup, backup restoration, business contact details, privacy notice, and order handoff before inviting customers.

## Project files

- `index.html`, `style.css`, `app.js`, `menu-data.js` — customer storefront, responsive design, and starter menu
- `admin.html`, `admin.css`, `admin.js` — private menu, restaurant settings, and order dashboard
- `server.js` — static site and validated menu, upload, admin, WhatsApp settings, and order APIs
- `setup-admin.js` — hidden-input interactive admin password setup
- `privacy.html` — owner-review privacy notice template
- `service-worker.js`, `manifest.webmanifest`, `app-icon.svg`, `app-icon-maskable.svg` — offline shell and install metadata
- `images/` — illustrative local stock photography
- `test/server.test.js` — API and order-inbox integration test

Run the integration test with `node --test`.
