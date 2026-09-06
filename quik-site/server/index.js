require('dotenv').config();
const path = require('path');
const express = require('express');
const Stripe = require('stripe');
const { db, getMeta, setMeta } = require('./db');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

const FREE_MS = 14 * 24 * 60 * 60 * 1000; // two weeks free
const GROWTH = 50; // squares added per dimension when the grid fills up
const RESERVATION_TTL_MS = 15 * 60 * 1000; // abandoned checkouts free up after 15 min

app.use(express.static(path.join(__dirname, '..', 'public')));

// --- helpers -----------------------------------------------------------

function currentGridSize() {
  return Number(getMeta('grid_size', 200));
}

function currentPrice() {
  const launch = Number(getMeta('launch_ts'));
  return Date.now() - launch < FREE_MS ? 0 : 1; // dollars per square
}

function purgeStaleReservations() {
  db.prepare('DELETE FROM reservations WHERE reserved_at < ?').run(Date.now() - RESERVATION_TTL_MS);
}

function logClaim({ x0, y0, x1, y1, count, color, label, price }) {
  db.prepare(
    `INSERT INTO claims_log (x0,y0,x1,y1,count,color,label,price,is_system,note,ts)
     VALUES (?,?,?,?,?,?,?,?,0,NULL,?)`
  ).run(x0, y0, x1, y1, count, color, label || null, price, Date.now());
}

function logSystem(note) {
  db.prepare(
    `INSERT INTO claims_log (x0,y0,x1,y1,count,color,label,price,is_system,note,ts)
     VALUES (0,0,0,0,0,NULL,NULL,0,1,?,?)`
  ).run(note, Date.now());
}

function maybeGrowGrid() {
  const size = currentGridSize();
  const claimed = db.prepare('SELECT COUNT(*) AS c FROM squares').get().c;
  if (claimed >= size * size) {
    const next = size + GROWTH;
    setMeta('grid_size', next);
    logSystem(`Every square filled up, so Quik grew to ${next}\u00d7${next} (${(next * next).toLocaleString()} squares).`);
  }
}

function boundsOf(cells) {
  const xs = cells.map((c) => c.x);
  const ys = cells.map((c) => c.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

// --- Stripe webhook (needs the raw body, so this is registered before express.json()) ---

app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature check failed:', err.message);
    return res.status(400).send('Webhook signature verification failed.');
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const cells = JSON.parse(session.metadata.cells);
    const color = session.metadata.color;
    const label = session.metadata.label || null;
    const now = Date.now();

    const insert = db.prepare(
      'INSERT OR IGNORE INTO squares (x,y,color,label,price_paid,claimed_at) VALUES (?,?,?,?,1,?)'
    );
    const dropReservation = db.prepare('DELETE FROM reservations WHERE x = ? AND y = ? AND session_id = ?');

    let count = 0;
    const tx = db.transaction((cells) => {
      cells.forEach(({ x, y }) => {
        const info = insert.run(x, y, color, label, now);
        if (info.changes) count++;
        dropReservation.run(x, y, session.id);
      });
    });
    tx(cells);

    if (count > 0) {
      const b = boundsOf(cells);
      logClaim({ ...b, count, color, label, price: 1 });
      maybeGrowGrid();
    }
  }

  res.json({ received: true });
});

app.use(express.json());

// --- API -----------------------------------------------------------------

app.get('/api/state', (req, res) => {
  purgeStaleReservations();
  const squares = db.prepare('SELECT x, y, color, label FROM squares').all();
  const reserved = db.prepare('SELECT x, y FROM reservations').all();
  const feed = db.prepare('SELECT * FROM claims_log ORDER BY id DESC LIMIT 25').all();

  res.json({
    gridSize: currentGridSize(),
    price: currentPrice(),
    launchTs: Number(getMeta('launch_ts')),
    squares,
    reserved,
    feed,
  });
});

app.post('/api/checkout', async (req, res) => {
  purgeStaleReservations();
  const { cells, color, label } = req.body || {};

  if (!Array.isArray(cells) || cells.length === 0) {
    return res.status(400).json({ error: 'No squares selected.' });
  }
  if (cells.length > 1000) {
    return res.status(400).json({ error: 'That is too many squares for one claim — try a smaller selection.' });
  }

  const size = currentGridSize();
  for (const { x, y } of cells) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= size || y >= size) {
      return res.status(400).json({ error: 'A square in that selection is out of range.' });
    }
  }

  const isTaken = db.prepare('SELECT 1 FROM squares WHERE x = ? AND y = ?');
  const isReserved = db.prepare('SELECT 1 FROM reservations WHERE x = ? AND y = ?');
  for (const { x, y } of cells) {
    if (isTaken.get(x, y) || isReserved.get(x, y)) {
      return res.status(409).json({ error: 'One or more of those squares were just taken — pick another spot.' });
    }
  }

  const safeColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#A33B20';
  const safeLabel = (label || '').toString().slice(0, 40) || null;
  const price = currentPrice();
  const b = boundsOf(cells);

  // Free period: claim immediately, no Stripe involved.
  if (price === 0) {
    const now = Date.now();
    const insert = db.prepare(
      'INSERT INTO squares (x,y,color,label,price_paid,claimed_at) VALUES (?,?,?,?,0,?)'
    );
    try {
      const tx = db.transaction((cells) => cells.forEach(({ x, y }) => insert.run(x, y, safeColor, safeLabel, now)));
      tx(cells);
    } catch (err) {
      return res.status(409).json({ error: 'One or more of those squares were just taken — pick another spot.' });
    }
    logClaim({ ...b, count: cells.length, color: safeColor, label: safeLabel, price: 0 });
    maybeGrowGrid();
    return res.json({ free: true });
  }

  // Paid period: reserve the squares so nobody else can grab them mid-checkout,
  // then hand off to Stripe. The squares only become permanent once the
  // webhook confirms payment.
  const sessionPlaceholder = 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const reserve = db.prepare(
    'INSERT INTO reservations (x,y,session_id,color,label,reserved_at) VALUES (?,?,?,?,?,?)'
  );
  try {
    const tx = db.transaction((cells) =>
      cells.forEach(({ x, y }) => reserve.run(x, y, sessionPlaceholder, safeColor, safeLabel, Date.now()))
    );
    tx(cells);
  } catch (err) {
    return res.status(409).json({ error: 'One or more of those squares were just taken — pick another spot.' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: `${cells.length} square${cells.length > 1 ? 's' : ''} on Quik` },
            unit_amount: 100, // $1.00 per square
          },
          quantity: cells.length,
        },
      ],
      metadata: { cells: JSON.stringify(cells), color: safeColor, label: safeLabel || '' },
      success_url: `${process.env.PUBLIC_URL}/?success=1`,
      cancel_url: `${process.env.PUBLIC_URL}/?canceled=1`,
    });
    db.prepare('UPDATE reservations SET session_id = ? WHERE session_id = ?').run(session.id, sessionPlaceholder);
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout creation failed:', err.message);
    db.prepare('DELETE FROM reservations WHERE session_id = ?').run(sessionPlaceholder);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Quik running on http://localhost:${PORT}`));
