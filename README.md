# EpiTrace — Outbreak Transmission Tracker

A real-time disease surveillance dashboard for tracking outbreak transmission chains, exposure events, and case timelines. Built with Flask and Leaflet.js.

Currently loaded with data from the **MV Hondius hantavirus outbreak (April 2026)**.

---

## Running Locally

```bash
pip install -r requirements.txt
python3 app.py
```

Open `http://localhost:5001` in your browser.

---

## Deploying to Replit

1. Import this repository into Replit (or upload the files).
2. Replit will detect `.replit` and run `python3 app.py` automatically.
3. The app reads the `PORT` environment variable set by Replit — no config needed.
4. Click **Run** and open the Webview.

---

## Adding Cases

Use the **Add Case** form in the sidebar, or edit `data/cases.json` directly.

Each case requires:
- `id` — unique identifier (e.g. `P005`)
- `name`, `age`, `sex`, `nationality`
- `status` — `confirmed`, `suspected`, `recovered`, or `deceased`
- `generation` — `0` for index case, `1` for direct contacts, etc.
- `infected_by` — `id` of source case, or `null` for index
- `onset_date` and `date` — ISO format (`YYYY-MM-DD`)
- `location` — object with `city`, `country`, `lat`, `lng`, `venue`

Transmission edges are stored in the `edges` array of `cases.json`.

---

## Data Disclaimer

This dashboard uses **unofficial, reconstructed data** for educational and situational-awareness purposes only.
