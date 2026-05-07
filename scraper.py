"""
Daily outbreak scraper — fetches WHO/ProMED/ECDC RSS feeds, extracts structured
case data using the Claude API, and merges new findings into cases.json.

Run directly:   python3 scraper.py
Via scheduler:  imported and called by app.py background thread
"""

import json
import os
import uuid
from datetime import datetime, timezone

try:
    import feedparser
except ImportError:
    feedparser = None

try:
    import requests as _requests
except ImportError:
    _requests = None

try:
    from anthropic import Anthropic
except ImportError:
    Anthropic = None

BASE_DIR = os.path.dirname(__file__)
DATA_DIR = os.path.join(BASE_DIR, "data")
CASES_F  = os.path.join(DATA_DIR, "cases.json")
LOG_F    = os.path.join(DATA_DIR, "scraper_log.json")

# Keywords that must appear in an article for it to be processed
KEYWORDS = [
    "hantavirus", "hondius", "cruise ship outbreak",
    "shipboard outbreak", "vessel outbreak", "ship disease",
]

# RSS sources — add more here as needed
SOURCES = [
    {"name": "WHO Disease Outbreak News", "url": "https://www.who.int/feeds/entity/csr/don/en/rss.xml"},
    {"name": "ProMED",                    "url": "https://promedmail.org/feed/"},
    {"name": "ECDC",                      "url": "https://www.ecdc.europa.eu/en/rss.xml"},
]

# Prompt sent to Claude for each matching article
_EXTRACT_PROMPT = """\
You are an epidemiological data extractor for a disease surveillance system.

Given the article below, extract any NEW cases or status changes.
Return ONLY valid JSON — no markdown, no explanation — in exactly this format:

{{
  "cases": [
    {{
      "name": "descriptive label (e.g. 'Belgian Passenger, Gen 2')",
      "age": null,
      "sex": null,
      "nationality": null,
      "status": "confirmed|suspected|recovered|deceased",
      "generation": 1,
      "infected_by": null,
      "onset_date": "YYYY-MM-DD or null",
      "date": "YYYY-MM-DD",
      "location": {{"city": "", "country": "", "venue": "", "lat": null, "lng": null, "state": ""}},
      "clinical_notes": "one-sentence summary from article only",
      "source_url": "{url}"
    }}
  ],
  "updates": [
    {{
      "match_name": "fragment of existing case name to find it",
      "field": "status or clinical_notes",
      "new_value": "updated value",
      "source_url": "{url}"
    }}
  ]
}}

Rules:
- Only extract what is EXPLICITLY stated. Do not infer or hallucinate.
- generation 0 = index/primary; 1 = direct contact; 2+ = secondary.
- Set infected_by to null unless the article names the source case.
- If nothing relevant, return {{"cases": [], "updates": []}}.

Article title: {title}
Published: {published}

Article text:
{text}
"""


# ---------------------------------------------------------------------------
# Helpers

def _load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def _save(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


# ---------------------------------------------------------------------------
# Fetch

def fetch_articles():
    """Pull all RSS sources, return articles matching KEYWORDS."""
    articles = []
    if not feedparser:
        print("[Scraper] feedparser not installed — install it via requirements.txt")
        return articles

    for src in SOURCES:
        try:
            feed = feedparser.parse(src["url"])
            for entry in feed.entries:
                combined = " ".join([
                    entry.get("title", ""),
                    entry.get("summary", ""),
                    entry.get("description", ""),
                ]).lower()
                if any(kw in combined for kw in KEYWORDS):
                    articles.append({
                        "source_name": src["name"],
                        "title":       entry.get("title", ""),
                        "url":         entry.get("link", ""),
                        "text":        entry.get("summary", entry.get("description", ""))[:4000],
                        "published":   entry.get("published", ""),
                    })
        except Exception as e:
            print(f"[Scraper] Error fetching {src['name']}: {e}")

    return articles


# ---------------------------------------------------------------------------
# Extract

def extract_from_article(article, client):
    """Send one article to Claude and return {cases, updates}."""
    prompt = _EXTRACT_PROMPT.format(
        url=article["url"],
        title=article["title"],
        published=article["published"],
        text=article["text"],
    )
    try:
        msg = client.messages.create(
            model="claude-opus-4-7",
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = msg.content[0].text.strip()
        # Strip markdown code fences if model wraps them
        if raw.startswith("```"):
            parts = raw.split("```")
            raw = parts[1] if len(parts) > 1 else raw
            if raw.startswith("json"):
                raw = raw[4:]
        return json.loads(raw.strip())
    except Exception as e:
        print(f"[Scraper] Extraction error for '{article['title']}': {e}")
        return {"cases": [], "updates": []}


# ---------------------------------------------------------------------------
# Merge

def _already_exists(cases, new_case):
    """True if a case with the same onset_date + nationality/age already exists."""
    onset = new_case.get("onset_date") or new_case.get("date", "")
    name_frag = new_case.get("name", "").lower()[:10]
    for c in cases:
        if onset and c.get("onset_date") == onset:
            if name_frag and name_frag in c.get("name", "").lower():
                return True
            if (new_case.get("nationality") and
                    c.get("nationality") == new_case.get("nationality") and
                    c.get("age") == new_case.get("age")):
                return True
    return False


def merge(all_new_cases, all_updates):
    data  = _load(CASES_F, {"cases": [], "edges": []})
    cases = data.get("cases", [])
    added, updated = [], []

    # Apply status / note updates to existing cases
    for upd in all_updates:
        frag = upd.get("match_name", "").lower()
        for c in cases:
            if frag and frag in c.get("name", "").lower():
                old_val = c.get(upd["field"])
                c[upd["field"]] = upd["new_value"]
                if not c.get("source_url"):
                    c["source_url"] = upd.get("source_url", "")
                updated.append({
                    "case_id": c["id"],
                    "field":   upd["field"],
                    "old":     old_val,
                    "new":     upd["new_value"],
                    "source":  upd.get("source_url", ""),
                })
                break

    # Append genuinely new cases
    for nc in all_new_cases:
        if _already_exists(cases, nc):
            continue
        nc["id"] = "P" + uuid.uuid4().hex[:5].upper()
        nc.setdefault("exposures",       [])
        nc.setdefault("flights",         [])
        nc.setdefault("transport",       {})
        nc.setdefault("ship_info",       None)
        nc.setdefault("incubation_start", None)
        nc.setdefault("reporter",        "Auto-scraped — verify before publishing")
        cases.append(nc)
        added.append(nc["id"])

    data["cases"] = cases
    _save(CASES_F, data)
    return added, updated


# ---------------------------------------------------------------------------
# Log

def log_run(articles, added, updated, error=None):
    log = _load(LOG_F, {"runs": []})
    log["runs"].append({
        "timestamp":        datetime.now(timezone.utc).isoformat(),
        "articles_matched": len(articles),
        "articles":         [{"title": a["title"], "url": a["url"]} for a in articles],
        "cases_added":      added,
        "cases_updated":    updated,
        "error":            str(error) if error else None,
    })
    log["runs"] = log["runs"][-90:]  # keep 90 days
    _save(LOG_F, log)


# ---------------------------------------------------------------------------
# Entry point

def run():
    """Run one scrape cycle. Returns summary dict."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        msg = "ANTHROPIC_API_KEY not set — scraper skipped"
        print(f"[Scraper] {msg}")
        log_run([], [], [], error=msg)
        return {"added": [], "updated": [], "articles": 0, "error": msg}

    if not Anthropic:
        msg = "anthropic package not installed"
        log_run([], [], [], error=msg)
        return {"added": [], "updated": [], "articles": 0, "error": msg}

    client = Anthropic(api_key=api_key)
    print(f"[Scraper] Run started — {datetime.now(timezone.utc).isoformat()}")

    articles = fetch_articles()
    print(f"[Scraper] {len(articles)} matching article(s) found")

    all_new, all_updates = [], []
    for article in articles:
        result = extract_from_article(article, client)
        all_new.extend(result.get("cases", []))
        all_updates.extend(result.get("updates", []))

    added, updated = merge(all_new, all_updates)
    log_run(articles, added, updated)

    print(f"[Scraper] Done — {len(added)} case(s) added, {len(updated)} update(s)")
    return {"added": added, "updated": updated, "articles": len(articles)}


if __name__ == "__main__":
    result = run()
    print(json.dumps(result, indent=2))
