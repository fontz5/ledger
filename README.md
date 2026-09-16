# Ledger — Tasks, Deadlines & Daily Plan

A single-file task planner that runs on **GitHub Pages** with **no backend required**.
Break tasks into subtasks, watch deadlines on a calendar, and time-block your day.
Data saves in your browser by default, with **optional Google Sheets sync** for cross-device use.

## What it does

- **Tasks** — add tasks with priority and a deadline; nest unlimited **subtasks**. Parent progress rolls up automatically from its children, and checking a parent completes everything under it.
- **Deadlines** — a month calendar showing every task on its due date, overdue items flagged, plus an upcoming-deadlines agenda.
- **Today** — an hourly planner (6:00–22:00) where you assign open tasks to time slots for any day.
- **Export / Import** — back up or move your data as JSON at any time.

---

## 1. Put it live on GitHub Pages (5 minutes)

1. Create a new GitHub repository (public).
2. Upload **`index.html`** to the repo root. (The `apps-script/` folder and this README are optional extras — they don't affect the site.)
3. Go to **Settings → Pages**.
4. Under **Build and deployment → Source**, choose **Deploy from a branch**.
5. Pick branch **`main`** and folder **`/ (root)`**, then **Save**.
6. Wait ~1 minute. Your app is live at:
   `https://<your-username>.github.io/<repo-name>/`

That's it — the app works fully at this point using in-browser storage.

> **Note on browser storage:** by default data lives in that one browser via `localStorage`. It won't follow you to another device or survive clearing site data. Use **Export JSON** for backups, or set up Sheets sync below.

---

## 2. Optional: sync to Google Sheets (cross-device)

GitHub Pages can only serve static files, so the app talks to a tiny **Google Apps Script web app** that reads and writes your sheet.

### Set up the backend

1. Create a new **Google Sheet** (any name).
2. In the sheet: **Extensions → Apps Script**.
3. Delete the placeholder code, then paste in everything from **`apps-script/Code.gs`**. **Save.**
4. Click **Deploy → New deployment**.
5. Click the gear ⚙ → choose **Web app**.
6. Set:
   - **Execute as:** *Me*
   - **Who has access:** *Anyone*
7. **Deploy**, approve the permission prompts, and **copy the Web app URL** (it ends in `/exec`).

### Connect the app

1. Open your live Ledger site.
2. Click the **Local** pill in the top-right.
3. Paste the `/exec` URL and **Save**. The pill turns green and reads **Sheets**.
4. Use **Push to Sheets** / **Pull from Sheets** in the bottom toolbar to sync.
   - **Push** writes your current data to the sheet.
   - **Pull** loads the sheet's data into the app.

Your data appears as JSON in the sheet's `tasks` and `slots` tabs — readable and editable directly if you ever want to.

> **Whose data is it?** The web-app URL is the key. Anyone with the URL can read/write that sheet, so treat it like a password and don't commit it into the repo. Sync is manual (Push/Pull) so you stay in control of when data moves.

---

## Customizing

Everything lives in `index.html` — HTML, CSS, and vanilla JS in one file, no build step.

- **Planner hours:** change `START_HOUR` / `END_HOUR` near the top of the Planner section.
- **Colors & fonts:** edit the CSS variables in `:root` at the top of the file.
- **Auto-sync:** the current design syncs on button press for safety; you could call `pushBtn.onclick`'s logic inside `save()` to sync on every change.

## Data model (for reference)

```
task = { id, title, due:"YYYY-MM-DD", pri:"low|med|high", done, parentId, createdAt }
slot = { id, date:"YYYY-MM-DD", hour:0-23, taskId }
```

## License

Do whatever you like with it.
