#!/usr/bin/env node
// Pulls Osmel's Facebook Marketplace listings into data/listings.json (+ data/listings.js)
// and img/. New listings are added, price changes are picked up, and listings that
// disappeared from his profile are marked sold (then dropped after SOLD_KEEP_DAYS).
//
//   node tools/sync.mjs                 full sync (opens Chrome; log in to Facebook the first time)
//   node tools/sync.mjs --ids=1,2,3     skip the profile scan and treat these ids as his active listings
//   node tools/sync.mjs --refresh       re-download details and photos for every active listing
//   node tools/sync.mjs --dry-run       show what would change without writing anything
//   node tools/sync.mjs --headless      no visible window (only works once the session is logged in)
//   node tools/sync.mjs --force         accept a big drop in listings (normally treated as a scrape failure)

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELLER_ID = '100015402496294';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_JSON = path.join(ROOT, 'data/listings.json');
const DATA_JS = path.join(ROOT, 'data/listings.js');
const IMG_DIR = path.join(ROOT, 'img');
const SESSION_DIR = path.join(ROOT, '.fb-session');
const SOLD_KEEP_DAYS = 14;
const MAX_PHOTOS = 4;

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

const profileUrl = `https://www.facebook.com/marketplace/profile/${SELLER_ID}/`;
const itemUrl = id => `https://www.facebook.com/marketplace/item/${id}/`;
const today = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- categorizing ----------

const CATEGORY_RULES = [
  ['builds', /gaming pc|\bpc for sale\b|full build|desktop/i],
  ['cooling', /cooler|water block|cpu block|\baio\b|cooling|fan/i],
  ['storage', /\bhdd\b|\bssd\b|nvme|\bnas\b|synology|hard drive/i],
  ['motherboards', /motherboard|\bb[3-8]\d0\b|\bx[3-8]\d0\b|\bz[3-8]\d0\b|combo/i],
  ['memory', /\bddr\d\b|\bram\b|\bdimm\b/i],
  ['graphics', /\brx ?\d{3,4}|\brtx ?\d{3,4}|\bgtx ?\d{3,4}|\barc a\d{3}|radeon|geforce/i],
  ['processors', /ryzen|intel core|\bi[3579][ -]\d{4,5}|athlon|threadripper/i],
  ['power-cases', /power supply|\bpsu\b|ax\d{3,4}i?|80 ?plus|\bcase\b|tower/i],
  ['audio', /krk|speaker|studio monitor|headphone|monitors\b/i],
];

export function categorize(title) {
  for (const [cat, re] of CATEGORY_RULES) if (re.test(title)) return cat;
  return 'other';
}

// ---------- reading Facebook ----------

async function ensureLoggedIn(context, page) {
  const loggedIn = async () => (await context.cookies('https://www.facebook.com')).some(c => c.name === 'c_user');
  if (await loggedIn()) return;
  if (args.headless) throw new Error('Not logged in to Facebook. Run once without --headless and log in in the window.');
  await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded' });
  console.log('Log in to Facebook in the Chrome window. Waiting up to 5 minutes...');
  for (let i = 0; i < 150 && !(await loggedIn()); i++) await sleep(2000);
  if (!(await loggedIn())) throw new Error('Timed out waiting for Facebook login.');
  console.log('Logged in.');
}

// Runs in the page: turns listing cards inside `root` into rows.
function readCards(root) {
  return [...root.querySelectorAll('a[href*="/marketplace/item/"]')].map(a => {
    const id = a.href.match(/item\/(\d+)/)[1];
    const lines = a.innerText.split('\n').map(s => s.trim()).filter(Boolean).filter(l => !/^just listed$/i.test(l));
    const prices = lines.filter(l => /^(\$[\d,]+|free)$/i.test(l));
    const rest = lines.filter(l => !prices.includes(l));
    return { id, price: prices[0] ?? null, was: prices[1] ?? null, title: rest[0] ?? '', location: rest[1] ?? '' };
  });
}

// Facebook only shows ~12 listings per view and won't page further, so we read the
// list under each sort order and merge. Newest + oldest covers up to 24 listings.
async function discover(page) {
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  const dialog = page.getByRole('dialog').filter({ has: page.locator('a[href*="/marketplace/item/"]') }).first();
  await dialog.waitFor({ timeout: 20000 });
  await sleep(2000);

  const found = new Map();
  const views = {};
  const grab = async name => {
    for (let i = 0; i < 4; i++) {
      await dialog.hover();
      await page.mouse.wheel(0, 2500);
      await sleep(900);
    }
    const rows = await dialog.evaluate(readCards);
    views[name] = rows.map(r => r.id);
    for (const r of rows) if (!found.has(r.id)) found.set(r.id, r);
  };

  await grab('default');
  for (const [name, label] of [['newest', /newest/i], ['oldest', /oldest/i], ['title', /title/i]]) {
    await dialog.getByRole('combobox', { name: /sort/i }).click();
    await page.getByRole('option', { name: label }).click();
    await sleep(2500);
    await grab(name);
  }

  const overlap = views.newest.filter(id => views.oldest.includes(id)).length;
  if (overlap === 0 && views.newest.length >= 12 && views.oldest.length >= 12) {
    console.warn(`Warning: newest and oldest views don't overlap, so he may have more than ${found.size} listings and some in the middle were missed.`);
  }

  const sellerText = await dialog.innerText();
  const m = sellerText.match(/(\d\.\d)\s*\((\d[\d,]*)\)/);
  const seller = m ? { rating: Number(m[1]), reviews: Number(m[2].replace(/,/g, '')) } : {};
  return { rows: [...found.values()], seller };
}

async function readItem(page, id) {
  await page.goto(itemUrl(id), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1', { timeout: 15000 }).catch(() => {});
  await sleep(2500);
  return page.evaluate(() => {
    const h1 = document.querySelector('h1')?.innerText.trim() ?? '';
    const text = document.body.innerText;
    const after = h1 ? text.slice(text.indexOf(h1) + h1.length, text.indexOf(h1) + h1.length + 200) : '';
    const pm = after.match(/^\s*(\$[\d,]+|Free)\s*(\$[\d,]+)?/i);
    const di = text.indexOf('\nDetails\n');
    const li = text.indexOf('Location is approximate', di);
    const details = di > 0 && li > 0 ? text.slice(di + 9, text.lastIndexOf('\n', li)).trim() : '';

    const isPhoto = i => i.naturalWidth >= 300 && /scontent|fbcdn/.test(i.src);
    const all = [...document.querySelectorAll('img')].filter(isPhoto);
    let photos = all.filter(i => i.getBoundingClientRect().width < 80).map(i => i.src);
    if (!photos.length) {
      const main = all.map(i => ({ i, r: i.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 250 && r.top < 700)
        .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
      if (main) photos = [main.i.src];
    }
    return { h1, price: pm?.[1] ?? null, was: pm?.[2] ?? null, details, photos: [...new Set(photos)] };
  });
}

function parseDetails(details) {
  const lines = details.split('\n').map(s => s.trim());
  const out = { condition: null, brand: null, description: '' };
  let i = 0;
  while (i < lines.length - 1 && /^(Condition|Brand|Model|Color|Size)$/.test(lines[i])) {
    const key = lines[i].toLowerCase();
    if (key in out) out[key] = lines[i + 1];
    i += 2;
  }
  out.description = lines.slice(i).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

async function savePhotos(context, id, srcs) {
  const saved = [];
  for (const [k, src] of srcs.slice(0, MAX_PHOTOS).entries()) {
    const res = await context.request.get(src);
    if (!res.ok()) continue;
    const rel = `img/${id}-${k}.jpg`;
    if (!args['dry-run']) await fs.writeFile(path.join(ROOT, rel), await res.body());
    saved.push(rel);
  }
  return saved;
}

// ---------- main ----------

const money = s => (s == null ? null : /free/i.test(s) ? 0 : Number(s.replace(/[$,]/g, '')));

async function loadExisting() {
  try { return JSON.parse(await fs.readFile(DATA_JSON, 'utf8')); }
  catch { return { seller: {}, listings: [] }; }
}

async function main() {
  await fs.mkdir(IMG_DIR, { recursive: true });
  await fs.mkdir(path.dirname(DATA_JSON), { recursive: true });
  const db = await loadExisting();
  const byId = new Map(db.listings.map(l => [l.id, l]));

  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: !!args.headless,
    viewport: { width: 1400, height: 900 },
  });
  const page = context.pages()[0] ?? await context.newPage();

  try {
    let rows, seller = {};
    if (args.ids) {
      rows = String(args.ids).split(',').map(id => ({ id: id.trim() })).filter(r => r.id);
    } else {
      await ensureLoggedIn(context, page);
      ({ rows, seller } = await discover(page));
    }
    console.log(`Found ${rows.length} active listings on Facebook.`);
    const wasActive = db.listings.filter(l => l.status === 'active').length;
    if (!args.force && (rows.length === 0 || rows.length < wasActive / 2)) {
      throw new Error(`Only found ${rows.length} listings but ${wasActive} were active last time. ` +
        'Facebook may have changed its layout, so nothing was marked sold. Re-run with --force if this is right.');
    }

    const changes = { added: [], priceChanged: [], sold: [], dropped: [] };
    const now = today();
    const activeIds = new Set(rows.map(r => r.id));

    for (const row of rows) {
      const prev = byId.get(row.id);
      const needsDetails = !prev || prev.status === 'sold' || args.refresh || !prev.photos?.length;
      let item = prev ? { ...prev } : { id: row.id, url: itemUrl(row.id), firstSeen: now };

      if (needsDetails) {
        process.stdout.write(`  reading ${row.id} ... `);
        const info = await readItem(page, row.id);
        const d = parseDetails(info.details);
        item = {
          ...item,
          title: info.h1 || row.title,
          condition: d.condition,
          brand: d.brand,
          description: d.description,
          price: money(row.price ?? info.price),
          was: money(row.was ?? info.was),
        };
        item.photos = await savePhotos(context, row.id, info.photos);
        console.log(`${item.title} (${item.photos.length} photos)`);
        await sleep(800);
      } else if (row.price != null) {
        const price = money(row.price);
        if (price !== item.price) changes.priceChanged.push({ id: item.id, title: item.title, from: item.price, to: price });
        item.price = price;
        item.was = money(row.was);
      }

      if (!prev) changes.added.push({ id: item.id, title: item.title, price: item.price });
      item.category = categorize(item.title);
      item.status = 'active';
      item.lastSeen = now;
      delete item.soldAt;
      byId.set(item.id, item);
    }

    for (const item of byId.values()) {
      if (activeIds.has(item.id)) continue;
      if (item.status === 'active') {
        item.status = 'sold';
        item.soldAt = now;
        changes.sold.push({ id: item.id, title: item.title, price: item.price });
      } else if (Date.now() - Date.parse(item.soldAt) > SOLD_KEEP_DAYS * 864e5) {
        byId.delete(item.id);
        changes.dropped.push({ id: item.id, title: item.title });
        if (!args['dry-run']) for (const p of item.photos ?? []) await fs.rm(path.join(ROOT, p), { force: true });
      }
    }

    const out = {
      seller: {
        name: 'Osmel Martinez',
        location: 'Jacksonville, FL',
        rating: 4.7,
        reviews: 409,
        profileUrl,
        ...db.seller,
        ...seller,
      },
      updatedAt: now,
      lastSync: changes,
      listings: [...byId.values()].sort((a, b) =>
        (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1) || b.firstSeen.localeCompare(a.firstSeen)),
    };

    console.log(`\nAdded ${changes.added.length}, price changes ${changes.priceChanged.length}, sold ${changes.sold.length}, dropped ${changes.dropped.length}.`);
    for (const a of changes.added) console.log(`  + ${a.title}  $${a.price}`);
    for (const p of changes.priceChanged) console.log(`  ~ ${p.title}  $${p.from} -> $${p.to}`);
    for (const s of changes.sold) console.log(`  - sold: ${s.title}`);

    if (args['dry-run']) { console.log('\nDry run: nothing written.'); return; }
    const json = JSON.stringify(out, null, 2);
    await fs.writeFile(DATA_JSON, json + '\n');
    await fs.writeFile(DATA_JS, `window.LISTINGS = ${json};\n`);
    console.log(`\nWrote ${path.relative(process.cwd(), DATA_JSON)} and ${path.relative(process.cwd(), DATA_JS)}.`);
  } finally {
    await context.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}
