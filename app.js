(() => {
  const data = window.LISTINGS;
  if (!data) {
    document.querySelector('main').innerHTML =
      '<p class="empty">No listings yet. Run <code>node tools/sync.mjs</code> to pull them from Facebook.</p>';
    return;
  }

  const CATEGORIES = {
    builds: 'Gaming PCs',
    processors: 'Processors',
    graphics: 'Graphics cards',
    motherboards: 'Motherboards and combos',
    memory: 'Memory',
    cooling: 'Cooling',
    storage: 'Storage',
    'power-cases': 'Power and cases',
    audio: 'Audio',
    other: 'Other',
  };

  const SPEC_KEYS = [
    [/^motherboard?/i, 'Motherboard'],
    [/^cpu/i, 'Processor'],
    [/^gpu/i, 'Graphics'],
    [/^ram/i, 'Memory'],
    [/^ssd/i, 'Storage'],
    [/^(aio cooler|cooler)/i, 'Cooling'],
    [/^power supply/i, 'Power supply'],
    [/^case/i, 'Case'],
  ];

  const $ = sel => document.querySelector(sel);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null) n.append(kid);
    return n;
  };

  const usd = n => (n === 0 ? 'Free' : '$' + n.toLocaleString('en-US'));
  const cleanTitle = t => {
    const s = t.replace(/💯\s*%?/gu, '100%').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/\s+/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  const tidyPart = s => s
    .replace(/x3d/gi, 'X3D')
    .replace(/\brx ?(\d{4})(xtx|xt)?\b/gi, (_, n, suf) => `RX ${n}${suf ? ' ' + suf.toUpperCase() : ''}`)
    .replace(/\bddr(\d)\b/gi, 'DDR$1')
    .replace(/(\d+)\s*gb\b/gi, '$1GB')
    .replace(/(\d+)\s*tb\b/gi, '$1TB');

  // "CPU Ryzen 7 9800x3d" -> { label: 'Processor', value: 'Ryzen 7 9800X3D' }
  function parseSpecs(description) {
    const specs = [], extras = [], notes = [];
    let inSpecs = false;
    for (const raw of description.split('\n')) {
      const line = raw.replace(/^specs\W*$/i, '').trim();
      if (/^specs/i.test(raw.trim())) { inSpecs = true; continue; }
      if (!line) { inSpecs = false; continue; }
      if (/^windows/i.test(line)) { specs.push({ label: 'Windows', value: line.replace(/^windows\s*/i, 'Windows ') }); continue; }
      const key = SPEC_KEYS.find(([re]) => re.test(line));
      if (key) {
        specs.push({ label: key[1], value: tidyPart(line.replace(key[0], '').trim()) });
      } else if (inSpecs && line.length < 60) {
        extras.push(tidyPart(line));
      } else {
        notes.push(line);
      }
    }
    return { specs, extras, notes };
  }

  const listings = data.listings.map(l => ({ ...l, name: cleanTitle(l.title) }));
  const active = listings.filter(l => l.status === 'active');
  const sold = listings.filter(l => l.status === 'sold');
  const seedDate = listings.reduce((m, l) => (l.firstSeen < m ? l.firstSeen : m), listings[0]?.firstSeen ?? '');
  const isNew = l => l.firstSeen > seedDate && Date.now() - Date.parse(l.firstSeen) < 7 * 864e5;

  // ---------- header ----------
  const s = data.seller;
  if (s.rating) $('#rating').append(
    el('span', { class: 'stars', 'aria-hidden': 'true' }, '★'),
    ` ${s.rating} from ${s.reviews.toLocaleString('en-US')} buyer reviews`
  );
  $('#profile-link').href = s.profileUrl;
  const updated = new Date(data.updatedAt);
  $('#updated').textContent = `Listings last updated ${updated.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} at ${updated.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`;

  // ---------- builds ----------
  const priceBlock = l => el('p', { class: 'price' },
    el('span', { class: 'now' }, usd(l.price)),
    l.was ? el('s', { class: 'was' }, el('span', { class: 'sr-only' }, 'was '), usd(l.was)) : null,
  );

  const builds = active.filter(l => l.category === 'builds').sort((a, b) => b.price - a.price);
  $('#builds').append(...builds.map(l => {
    const { specs, extras, notes } = parseSpecs(l.description);
    const cpu = specs.find(x => x.label === 'Processor')?.value;
    const gpu = specs.find(x => x.label === 'Graphics')?.value.replace(/\s\d+GB.*$/, '').replace(/\s(sapphire|gigabyte|msi|asus).*$/i, '');
    const name = cpu && gpu ? `${cpu} with ${gpu}` : l.name;
    const hero = l.photos[1] ?? l.photos[0];
    return el('article', { class: 'build', style: `--glow: url("${hero}")` },
      el('div', { class: 'build-photo' },
        el('img', { src: hero, alt: `${name} gaming PC`, loading: 'eager' })),
      el('div', { class: 'build-info' },
        el('h3', {}, name),
        priceBlock(l),
        el('p', { class: 'condition' }, l.condition),
        el('dl', { class: 'specs' }, specs.map(x => [el('dt', {}, x.label), el('dd', {}, x.value)])),
        extras.length ? el('p', { class: 'extras' }, 'Also includes ' + extras.join(', ').toLowerCase() + '.') : null,
        notes.length ? el('p', { class: 'note' }, notes.join(' ')) : null,
        el('div', { class: 'actions' },
          el('a', { class: 'btn btn-main', href: l.url, target: '_blank', rel: 'noopener' }, 'Message Osmel on Facebook'),
          el('button', { class: 'btn btn-quiet', type: 'button', onclick: () => openDetail(l) }, `See ${l.photos.length} photos`)),
      ));
  }));

  // ---------- parts ----------
  const parts = active.filter(l => l.category !== 'builds');
  const state = { cat: 'all', q: '', sort: 'new' };

  const counts = parts.reduce((m, l) => (m[l.category] = (m[l.category] ?? 0) + 1, m), {});
  const chipDefs = [['all', 'All', parts.length],
    ...Object.keys(CATEGORIES).filter(c => counts[c]).map(c => [c, CATEGORIES[c], counts[c]])];
  $('#chips').append(...chipDefs.map(([key, label, n]) =>
    el('button', { type: 'button', class: 'chip', 'data-cat': key, 'aria-pressed': String(key === 'all'),
      onclick: () => { state.cat = key; renderGrid(); } },
      label, el('span', { class: 'count' }, String(n)))));

  $('#q').addEventListener('input', e => { state.q = e.target.value.trim().toLowerCase(); renderGrid(); });
  $('#sort').addEventListener('change', e => { state.sort = e.target.value; renderGrid(); });

  const tile = l => el('li', { class: 'tile' },
    el('button', { type: 'button', class: 'tile-btn', onclick: () => openDetail(l), 'aria-label': `${l.name}, ${usd(l.price)}. See details` },
      el('div', { class: 'tile-photo' },
        el('img', { src: l.photos[0], alt: '', loading: 'lazy' }),
        isNew(l) ? el('span', { class: 'flag flag-new' }, 'New') : l.was ? el('span', { class: 'flag flag-drop' }, 'Price dropped') : null),
      priceBlock(l),
      el('p', { class: 'tile-name' }, l.name),
      el('p', { class: 'tile-meta' }, l.condition)));

  function renderGrid() {
    document.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.cat === state.cat)));
    let rows = parts.filter(l => (state.cat === 'all' || l.category === state.cat)
      && (!state.q || (l.title + ' ' + l.description).toLowerCase().includes(state.q)));
    if (state.sort === 'low') rows.sort((a, b) => a.price - b.price);
    else if (state.sort === 'high') rows.sort((a, b) => b.price - a.price);
    else rows.sort((a, b) => b.firstSeen.localeCompare(a.firstSeen));
    $('#grid').replaceChildren(...rows.map(tile));
    $('#empty').hidden = rows.length > 0;
  }
  renderGrid();

  // ---------- sold ----------
  if (sold.length) {
    $('#sold-section').hidden = false;
    $('#sold').append(...sold.map(l => el('li', { class: 'sold-item' },
      el('img', { src: l.photos[0], alt: '', loading: 'lazy' }),
      el('div', {}, el('p', { class: 'tile-name' }, l.name), el('p', { class: 'tile-meta' }, `Sold for ${usd(l.price)}`)))));
  }

  // ---------- detail dialog ----------
  const dlg = $('#detail');
  function openDetail(l) {
    const show = src => {
      $('#detail-img').src = src;
      $('#detail-img').alt = l.name;
      document.querySelectorAll('#detail-thumbs button').forEach(b => b.setAttribute('aria-current', String(b.dataset.src === src)));
    };
    $('#detail-cat').textContent = CATEGORIES[l.category];
    $('#detail-title').textContent = l.name;
    $('#detail-price').replaceChildren(...priceBlock(l).childNodes);
    $('#detail-condition').textContent = l.condition ?? '';
    $('#detail-desc').replaceChildren(...l.description.split(/\n+/).filter(Boolean).map(p => el('p', {}, p)));
    $('#detail-link').href = l.url;
    $('#detail-thumbs').replaceChildren(...(l.photos.length > 1 ? l.photos : []).map((src, i) =>
      el('button', { type: 'button', 'data-src': src, 'aria-label': `Photo ${i + 1}`, onclick: () => show(src) },
        el('img', { src, alt: '' }))));
    show(l.photos[0]);
    dlg.showModal();
  }
  $('#detail-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
})();
