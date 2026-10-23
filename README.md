# Osmel Martinez: PCs and parts (demo)

A small static site that shows Osmel's Facebook Marketplace listings, plus a script that keeps it in sync.

## Look at the site

Open `index.html` in a browser, or run `npm run preview` and go to http://localhost:8802.

## Update the listings

```
npm install          # first time only
npm run sync
```

The first run opens a Chrome window. Log in to Facebook there once; the login is kept in `.fb-session/` (never committed).

Each sync:

- reads every listing on Osmel's Marketplace profile
- downloads details and up to 4 photos for anything new into `img/`
- updates prices that changed (old price shows struck through)
- marks listings that are gone as **sold**, shows them under "Recently sold" for 14 days, then deletes them and their photos
- writes `data/listings.json` and `data/listings.js` (the site reads the `.js` file)

Then commit and push to publish.

Useful flags:

| Flag | What it does |
| --- | --- |
| `--dry-run` | Shows what would change without writing anything |
| `--ids=1,2,3` | Skips the profile scan and uses these listing ids as the active set (no login needed) |
| `--refresh` | Downloads details and photos again for every listing |
| `--headless` | No visible window (after you've logged in once) |
| `--force` | Accepts a big drop in listing count, which is normally treated as a failed scan |

## Limits

- Facebook shows about 12 listings per view, so the script reads the list sorted newest-first, oldest-first and A-Z and merges them. That covers up to about 24 listings; it warns if it looks like some were missed.
- Facebook can change its page layout at any time, which can break the scan. If a sync finds far fewer listings than last time, it stops instead of marking everything sold.
- Facebook's terms don't allow automated collection, so run this by hand, for Osmel's own listings, with his permission.
