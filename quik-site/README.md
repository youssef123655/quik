# Quik — from prototype to a real, payable site

This folder is a working starting point: a Node/Express backend, a SQLite
database, Stripe for the actual card payments, and the same look you saw
in the artifact, now talking to that backend instead of demo storage.

## Why each piece is here

- **Database (`quik.db`, created automatically)** — this is the part the
  in-browser demo couldn't safely do. It's the one place that decides who
  owns which square, so two people can never buy the same one: `(x, y)`
  is the table's primary key, so a second attempt is rejected outright
  instead of silently overwriting the first buyer.
- **Backend (`server/`)** — the only thing that holds your Stripe secret
  key and is allowed to write to the database. The browser is never
  trusted to say "I paid" — only Stripe's webhook can do that.
- **Stripe Checkout** — the actual card entry happens on a page hosted by
  Stripe. Your server never sees a card number, which keeps you out of
  PCI-compliance territory entirely.
- **Frontend (`public/`)** — what visitors see. It now calls `/api/state`
  and `/api/checkout` instead of writing to the browser's local storage.

## Run it locally

1. Install Node.js 18 or newer.
2. `npm install`
3. Create a free Stripe account and grab your **test** secret key from
   the dashboard.
4. `cp .env.example .env`, then fill in `STRIPE_SECRET_KEY`.
5. `npm start`, then open http://localhost:3000.
6. To actually test a paid claim locally, install the [Stripe
   CLI](https://stripe.com/docs/stripe-cli) and run:
   `stripe listen --forward-to localhost:3000/api/webhook`
   It will print a `whsec_...` value — put that in `.env` as
   `STRIPE_WEBHOOK_SECRET` and restart the server.

While you're still inside the two-week free window, claiming is instant
and Stripe isn't involved at all — you'll only see the checkout redirect
once that window ends (or you shorten `FREE_MS` in `server/index.js` to
test it sooner).

## Taking it live

1. **Host it somewhere with a real, persistent disk** — Render, Railway,
   Fly.io, or any VPS all work well. Skip serverless platforms like
   Vercel or Netlify functions for this specific setup: their filesystem
   resets on every request, which would wipe the SQLite file. (A hosted
   Postgres instead of SQLite would remove that restriction — see below.)
2. **Buy a domain** and point its DNS at your host.
3. Set `PUBLIC_URL` in `.env` to your real domain, and switch to a live
   Stripe secret key (`sk_live_...`) once you're ready for real charges.
4. In the Stripe dashboard, add a webhook endpoint at
   `https://yourdomain.com/api/webhook` subscribed to
   `checkout.session.completed`, and put its signing secret in `.env`.
5. `.env` is already excluded via `.gitignore` — never commit it or your
   Stripe keys.

## Worth doing before you announce it publicly

- **Terms of service + a refund/removal policy.** Anyone can put any
  color and a short label on a square — decide up front what you'll do
  if someone claims something you don't want shown, and say so.
- **A way to report a square**, even a simple mailto link at first.
- **Rate limiting** on `/api/checkout` (the `express-rate-limit` package
  is a quick add) so one visitor can't hammer the endpoint.
- **Backups** of `quik.db` on a schedule, since it's a single file.
- **More traffic than one small server can handle?** Move from SQLite to
  a hosted Postgres (Supabase, Neon, and Railway all have a free tier).
  The queries in `server/db.js` are simple enough that the rewrite is
  mostly mechanical.

I'm not a lawyer, and this isn't legal advice — for anything involving
real payments and user-submitted content, it's worth a short
conversation with one about your terms and any local rules that apply
to collecting money this way.

## File map

```
quik-site/
  package.json
  .env.example        # copy to .env and fill in
  server/
    index.js           # Express app, Stripe checkout + webhook, growth logic
    db.js               # SQLite schema and small helpers
  public/
    index.html
    styles.css
    app.js              # fetches /api/state, posts to /api/checkout
```
