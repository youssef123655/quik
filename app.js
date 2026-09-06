// ===== FIREBASE CONFIGURATION =====
const firebaseConfig = {
    apiKey: "AIzaSyDf9ww6nAKQjHE_rjWObQzBadcfok7EqZc",
    authDomain: "quik-b2881.firebaseapp.com",
    projectId: "quik-b2881",
    storageBucket: "quik-b2881.firebasestorage.app",
    messagingSenderId: "742780736000",
    appId: "1:742780736000:web:0b0067a760d1d7f3cabee5",
    measurementId: "G-JY2KP1Q360"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

(function () {
  const CELL = 4;
  const FREE_MS = 14 * 24 * 60 * 60 * 1000;
  const POLL_MS = 2000;

  const canvas = document.getElementById('grid');
  const ctx = canvas.getContext('2d');

  const PAPER = '#E8E2D0';
  const LINE = 'rgba(31,42,36,0.10)';

  const swatchColors = ['#A33B20', '#3D5A45', '#1F2A24', '#C9A24B', '#2E6E75', '#6B3F69', '#F5F1E6', '#3B5BA5'];
  let chosenColor = swatchColors[0];

  let GRID = 200;
  let price = 0;
  let launchTs = Date.now();
  let cellsMap = {};
  let takenSet = new Set();
  let feedCache = [];

  let selecting = false;
  let startCell = null, endCell = null;
  let zoomIdx = 1;
  const zoomLevels = [0.5, 1, 1.6, 2.2];

  const swatchWrap = document.getElementById('color-swatches');
  swatchColors.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (i === 0 ? ' selected' : '');
    b.style.background = c;
    b.addEventListener('click', () => {
      chosenColor = c;
      document.getElementById('custom-color').value = c;
      [...swatchWrap.children].forEach((el) => el.classList.remove('selected'));
      b.classList.add('selected');
    });
    swatchWrap.appendChild(b);
  });

  const customColor = document.getElementById('custom-color');
  customColor.addEventListener('input', () => {
    chosenColor = customColor.value;
    [...swatchWrap.children].forEach((el) => el.classList.remove('selected'));
  });

  function key(x, y) { return x + ',' + y; }
  function isTaken(x, y) { return takenSet.has(key(x, y)); }

  function freeDaysLeft() {
    const left = FREE_MS - (Date.now() - launchTs);
    return Math.max(0, Math.ceil(left / (24 * 60 * 60 * 1000)));
  }

  function resizeCanvas() {
    canvas.width = GRID * CELL;
    canvas.height = GRID * CELL;
    applyZoom();
  }

  function applyZoom() {
    const size = Math.round(GRID * CELL * zoomLevels[zoomIdx]);
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    document.getElementById('zoom-level').textContent = zoomLevels[zoomIdx] + '×';
  }
  document.getElementById('zoom-in').addEventListener('click', () => {
    zoomIdx = Math.min(zoomIdx + 1, zoomLevels.length - 1);
    applyZoom();
  });
  document.getElementById('zoom-out').addEventListener('click', () => {
    zoomIdx = Math.max(zoomIdx - 1, 0);
    applyZoom();
  });

  function draw() {
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (const k in cellsMap) {
      const [x, y] = k.split(',').map(Number);
      ctx.fillStyle = cellsMap[k].color;
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
    }

    ctx.strokeStyle = LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= GRID; i++) {
      const p = i * CELL + 0.5;
      ctx.moveTo(p, 0); ctx.lineTo(p, canvas.height);
      ctx.moveTo(0, p); ctx.lineTo(canvas.width, p);
    }
    ctx.stroke();

    if (startCell && endCell) {
      const { x0, y0, x1, y1 } = rectFrom(startCell, endCell);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          ctx.fillStyle = isTaken(x, y) ? 'rgba(31,42,36,0.55)' : 'rgba(163,59,32,0.30)';
          ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
        }
      }
      ctx.strokeStyle = '#1F2A24';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0 * CELL + 0.75, y0 * CELL + 0.75, (x1 - x0 + 1) * CELL - 1.5, (y1 - y0 + 1) * CELL - 1.5);
    }
  }

  function rectFrom(a, b) {
    return {
      x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x),
      y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y),
    };
  }

  function cellFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) / rect.width * GRID;
    const cy = (e.clientY - rect.top) / rect.height * GRID;
    return {
      x: Math.max(0, Math.min(GRID - 1, Math.floor(cx))),
      y: Math.max(0, Math.min(GRID - 1, Math.floor(cy))),
    };
  }

  function availableCellsInRect(x0, y0, x1, y1) {
    const cells = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) if (!isTaken(x, y)) cells.push({ x, y });
    return cells;
  }

  function updateSelectionUI() {
    const info = document.getElementById('selection-info');
    const btn = document.getElementById('buy-btn');
    info.classList.remove('blocked');

    if (!startCell || !endCell) {
      info.innerHTML = 'Click a square, or drag across several.';
      btn.disabled = true;
      btn.textContent = 'Select squares first';
      return;
    }
    const { x0, y0, x1, y1 } = rectFrom(startCell, endCell);
    const total = (x1 - x0 + 1) * (y1 - y0 + 1);
    const available = availableCellsInRect(x0, y0, x1, y1).length;
    const priceLabel = price === 0 ? 'Free' : ('$' + available * price);

    if (available === 0) {
      info.textContent = 'Every square in that selection is already taken — try another spot.';
      info.classList.add('blocked');
      btn.disabled = true;
      btn.textContent = 'Nothing available there';
      return;
    }

    let msg = 'Selected <strong>' + available + '</strong> available square' + (available > 1 ? 's' : '');
    if (available < total) msg += ' (' + (total - available) + ' already taken)';
    msg += '.';
    info.innerHTML = msg;
    btn.disabled = false;
    btn.textContent = 'Claim ' + available + ' square' + (available > 1 ? 's' : '') + ' — ' + priceLabel;
  }

  function renderStats() {
    const claimed = Object.keys(cellsMap).length;
    const total = GRID * GRID;
    document.getElementById('stat-claimed').textContent = claimed.toLocaleString();
    document.getElementById('stat-open').textContent = (total - claimed).toLocaleString();
    document.getElementById('stat-price').textContent =
      price === 0 ? ('Free (' + freeDaysLeft() + 'd left)') : '$1 / square';

    let raised = 0;
    feedCache.forEach((f) => { if (!f.is_system) raised += (f.price || 0) * f.count; });
    document.getElementById('stat-raised').textContent = '$' + raised.toLocaleString();

    document.getElementById('kicker').textContent =
      total.toLocaleString() + ' squares · ' +
      (price === 0 ? 'free for ' + freeDaysLeft() + ' more day' + (freeDaysLeft() === 1 ? '' : 's') : '$1 each');
  }

  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  function renderFeed() {
    const list = document.getElementById('feed-list');
    if (!feedCache.length) {
      list.innerHTML = '<li class="empty">Nobody has claimed a square yet — be first.</li>';
      return;
    }
    list.innerHTML = '';
    feedCache.forEach((entry) => {
      const li = document.createElement('li');
      if (entry.is_system) {
        li.className = 'system';
        li.textContent = entry.note;
        const meta = document.createElement('span');
        meta.className = 'feed-meta';
        meta.textContent = timeAgo(entry.ts);
        li.appendChild(meta);
        list.appendChild(li);
        return;
      }
      const sw = document.createElement('span');
      sw.className = 'feed-swatch';
      sw.style.background = entry.color;
      const label = document.createElement('span');
      const size = entry.count > 1 ? entry.count + ' squares' : '1 square';
      const priceTxt = entry.price === 0 ? 'free' : ('$' + entry.price * entry.count);
      label.textContent = size + ' at (' + entry.x0 + ', ' + entry.y0 + ') — ' + priceTxt +
        (entry.label ? ' — "' + entry.label + '"' : '');
      const meta = document.createElement('span');
      meta.className = 'feed-meta';
      meta.textContent = timeAgo(entry.ts);
      li.appendChild(sw); li.appendChild(label); li.appendChild(meta);
      list.appendChild(li);
    });
  }

  function showFlash(message, isError) {
    const el = document.getElementById('flash');
    el.textContent = message;
    el.className = 'flash show' + (isError ? ' error' : '');
  }

  // ===== LOAD STATE FROM FIREBASE =====
  function loadStateFromFirebase() {
    db.ref('state/launchTs').once('value', (snap) => {
      if (snap.exists()) {
        launchTs = snap.val();
      }
    });

    db.ref('pixels').once('value', (snapshot) => {
      const data = snapshot.val();
      cellsMap = {};
      takenSet = new Set();
      feedCache = [];

      if (data) {
        for (let index in data) {
          const [x, y] = index.split(',').map(Number);
          const pixelData = data[index];
          const k = key(x, y);
          cellsMap[k] = { color: pixelData.color, label: pixelData.label || '' };
          takenSet.add(k);

          feedCache.push({
            x0: x,
            y0: y,
            count: 1,
            color: pixelData.color,
            label: pixelData.label || '',
            price: price,
            ts: pixelData.timestamp || Date.now()
          });
        }
      }

      draw();
      renderStats();
      renderFeed();
    });
  }

  // ===== LIVE UPDATES FROM FIREBASE =====
  db.ref('pixels').on('child_added', (snapshot) => {
    const index = snapshot.key;
    const [x, y] = index.split(',').map(Number);
    const data = snapshot.val();
    const k = key(x, y);

    cellsMap[k] = { color: data.color, label: data.label || '' };
    takenSet.add(k);

    feedCache.push({
      x0: x,
      y0: y,
      count: 1,
      color: data.color,
      label: data.label || '',
      price: price,
      ts: data.timestamp || Date.now()
    });

    draw();
    renderStats();
    renderFeed();
  });

  // ===== CLAIM PIXELS (Save to Firebase) =====
  async function claimPixels(cells, color, label) {
    const updates = {};
    const timestamp = Date.now();

    cells.forEach((cell) => {
      const k = key(cell.x, cell.y);
      updates['pixels/' + k] = {
        color: color,
        label: label,
        timestamp: timestamp
      };
    });

    if (!launchTs) {
      updates['state/launchTs'] = timestamp;
    }

    await db.ref().update(updates);
    return true;
  }

  // ===== EVENT HANDLERS =====
  canvas.addEventListener('mousedown', (e) => {
    selecting = true;
    startCell = endCell = cellFromEvent(e);
    updateSelectionUI();
    draw();
  });

  canvas.addEventListener('mousemove', (e) => {
    const c = cellFromEvent(e);
    document.getElementById('hover-coord').textContent = '(' + c.x + ', ' + c.y + ')';
    const owned = cellsMap[key(c.x, c.y)];
    canvas.title = owned && owned.label ? owned.label : '';
    if (selecting) {
      endCell = c;
      updateSelectionUI();
      draw();
    }
  });

  window.addEventListener('mouseup', () => { selecting = false; });
  canvas.addEventListener('mouseleave', () => {
    document.getElementById('hover-coord').textContent = '';
  });

  // ===== BUY BUTTON =====
  document.getElementById('buy-btn').addEventListener('click', async () => {
    if (!startCell || !endCell) return;
    const { x0, y0, x1, y1 } = rectFrom(startCell, endCell);
    const cells = availableCellsInRect(x0, y0, x1, y1);
    if (!cells.length) return;

    const label = document.getElementById('claim-label').value.trim().slice(0, 40);
    const btn = document.getElementById('buy-btn');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Processing…';

    try {
      await claimPixels(cells, chosenColor, label);

      startCell = endCell = null;

      showFlash('✅ Your squares have been claimed!', false);

      updateSelectionUI();
      draw();
      renderStats();
      renderFeed();

    } catch (err) {
      showFlash('❌ Something went wrong. Please try again.', true);
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  // ===== INIT =====
  resizeCanvas();
  loadStateFromFirebase();
})();
