# PIN — Tasks, Deadlines & Daily Plan

A static task and schedule planner that runs on **GitHub Pages** with **no backend required**.
Break work into subtasks, track deadlines on a month calendar, time-block your day, and keep
recurring routines. Data saves in your browser by default, with **optional Google Sheets sync**
for cross-device use.

Plain ES modules — no build step, no bundler, no package manager.

## The four views

- **Tasks** — three item types in one tree: **finite** tasks (with unlimited nested subtasks and
  automatic weighted progress rollup), **routines** (recurring, completion logged per occurrence),
  and **events** (standalone or attached to a container, all-day / multi-day / recurring). Overdue
  items lift into a pinned **Overdue** section. Tapping any item opens a read-only detail popup,
  with Edit and Delete as secondary actions.
- **Deadlines** — a countdown list of everything with a deadline ("N days"). Tapping one jumps to
  Calendar Month mode with a **runway highlight**: yellow from today to the day before, red on the
  due date.
- **Calendar** — **Day**, **Week**, and **Month** modes. Day and Week are a real time grid rendering
  your planner slots and events together, with a now-line, side-by-side lanes for overlaps, and
  drag to move or resize a block (every drag has a tap-to-edit fallback). Month is the 7×4–6 grid
  with per-day markers and tap-to-expand day detail.
- **Settings** — Google Sheets sync (below), the **Day markers** picker for the Month grid,
  and **Export / Import** of your data to a file (below).

## Add it to your phone's home screen

Open the live site in Safari (iOS) or Chrome (Android) and choose **Add to Home Screen**. It then
launches full-screen like an app, using the bundled `manifest.json` and `icons/`.

---

## 1. Put it live on GitHub Pages (5 minutes)

1. Create a new GitHub repository (public).
2. Put **the whole repo** on its `main` branch — either push it with git
   (`git remote add origin https://github.com/<your-username>/<repo-name>.git`, then
   `git push -u origin main`) or upload the files in the web UI. It must include `index.html`,
   `css/`, `js/`, `icons/`, and `manifest.json`: the app is ES modules across several files, so
   `index.html` on its own will **not** work. (`apps-script/`, `test.mjs`, and this README are
   optional extras that don't affect the site.)
3. Go to **Settings → Pages**.
4. Under **Build and deployment → Source**, choose **Deploy from a branch**.
5. Pick branch **`main`** and folder **`/ (root)`**, then **Save**.
6. Wait ~1 minute (up to 10). Your app is live at:
   `https://<your-username>.github.io/<repo-name>/`

That's it — the app works fully at this point using in-browser storage.

> **Note on browser storage:** by default data lives in that one browser via `localStorage`. It
> won't follow you to another device, and iOS Safari can evict it after a period of not visiting
> the site. Set up Sheets sync below if you want a copy that isn't only in the browser.

### Running it locally

ES modules need a real http origin, not `file://`:

```bash
python3 -m http.server 8000    # then open http://localhost:8000
```

---

## 2. Optional: sync to Google Sheets (cross-device)

GitHub Pages can only serve static files, so the app talks to a tiny **Google Apps Script web app**
that reads and writes your sheet. Sync is **local-first and on demand**: the app always works from
browser storage, and data only moves when you press Push or Pull.

### Set up the backend

1. Create a new **Google Sheet** (any name).
2. In the sheet: **Extensions → Apps Script**.
3. Delete the placeholder code, then paste in everything from **`apps-script/Code.gs`**. **Save.**
4. **Project Settings → Script properties → Add script property.** Name it `TOKEN` and give it a
   secret value of your choosing. This is the shared secret every request must present, and it is
   never written into the source file.
5. Click **Deploy → New deployment**.
6. Click the gear ⚙ → choose **Web app**.
7. Set:
   - **Execute as:** *Me*
   - **Who has access:** *Anyone*
8. **Deploy**, approve the permission prompts, and **copy the Web app URL** (it ends in `/exec`).

### Connect the app

1. Open your live PIN site and go to the **Settings** tab.
2. Paste the `/exec` URL into **Apps Script exec URL**, and your `TOKEN` value into **Token**.
3. Press **Connect**. A successful connect confirms the URL and token together — a wrong or missing
   token is rejected by the script with `unauthorized` and touches no data.
4. Then use **Push** and **Pull** whenever you want to move data:
   - **Push** writes your current tasks and slots to the sheet.
   - **Pull** loads the sheet's tasks and slots into the app.

The script creates three tabs, and the two data tabs are stored differently:

- **`slots`** — one row per slot, with a header row and the columns `id`, `owner`, `date`,
  `start`, `durationMin`, `taskId`. Readable and editable directly in the sheet.
- **`tasks`** — the whole task list as a **single JSON string in cell `A1`**, not one row per
  task. It's still readable, but it's one long line rather than a table.
- **`meta`** — the data version in `A1`. Leave it alone.

> **One size limit worth knowing.** Because the task list is a single cell, it's bounded by
> Google's ~50,000-character cell limit — roughly 176 tasks. Slots aren't affected, since they
> get a row each. You'll hit nothing of the sort in normal use, but that's the ceiling.

> **Your settings never sync.** The exec URL and the token stay in this browser only and are never
> written to the sheet they authenticate against. The exec URL plus the token is the key to your
> data, so treat the pair like a password and never commit either into the repo.

---

## 3. Back up or move your data: Export / Import

No Google account needed. Both controls are under **Your data** at the bottom of the **Settings** tab.

- **Export to a file** downloads `pin-export-YYYY-MM-DD.json` (today's local date). It holds your
  tasks, your slots, and your **Day markers** choices. It **never** contains the Apps Script exec
  URL or the token, so the file is safe to email to yourself or keep in cloud storage.
- **Import from a file** reads a file you exported earlier (from this or any other device) and
  **replaces** your local tasks and schedule with its contents, after a confirmation. Cancel the
  confirmation and nothing changes.
  - A file that isn't a valid export (not JSON, or missing the task/slot lists) is rejected with an
    error message, and your data is left exactly as it was.
  - Your Sheets exec URL and token on this device are kept as they are; importing never clears them.
  - Older exports still import; they're upgraded to the current format on the way in.
  - Day markers come from the file. A file exported before the app had the Day markers picker
    resets them to the default (coloured dots), so re-pick emoji markers in Settings afterwards if
    you used them.

Import is the quickest way to move to a new phone: Export on the old one, get the file across
(AirDrop, email, iCloud Drive), then Import on the new one. To keep the two in step after that, use
Sheets sync.

---

## Customizing

- **Design tokens** (colours, fonts, spacing) — the CSS variables in `:root` at the top of
  `css/styles.css`.
- **Code layout** — `js/state.js` (record factories), `js/logic.js` (pure functions: progress,
  recurrence, layout — no DOM, no storage), `js/storage.js` (the only module that touches
  `localStorage` or the network), `js/views/*.js` (one module per view), `js/app.js` (boot + nav).
- **Sample data** — append `?seed=1` to the URL to load the dev fixture. It asks before overwriting
  what you already have.

## Tests

Node is a dev-only tool here; nothing in the shipped app needs it.

```bash
node test.mjs
```

## License

Do whatever you like with it.
