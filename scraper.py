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
    "hantavirus", "hondius", "andes virus", "hantaviral",
    "cruise ship outbreak", "shipboard outbreak",
]

# RSS sources
SOURCES = [
    # Google News — catches everything from every outlet, updated constantly
    {
        "name": "Google News — hantavirus",
        "url":  "https://news.google.com/rss/search?q=hantavirus&hl=en-US&gl=US&ceid=US:en",
    },
    {
        "name": "Google News — MV Hondius",
        "url":  "https://news.google.com/rss/search?q=hondius+hantavirus&hl=en-US&gl=US&ceid=US:en",
    },
    # WHO official outbreak news
    {
        "name": "WHO Disease Outbreak News",
        "url":  "https://www.who.int/feeds/entity/csr/don/en/rss.xml",
    },
    # ProMED — gold-standard expert outbreak alerts
    {
        "name": "ProMED",
        "url":  "https://promedmail.org/feed/",
    },
    # Outbreak News Today — small independent site, never blocks scrapers
    {
        "name": "Outbreak News Today",
        "url":  "http://outbreaknewstoday.com/feed/",
    },
]

# Seen-URL cache file — prevents reprocessing the same article on future runs
SEEN_F = os.path.join(DATA_DIR, "scraper_seen.json")

# HTTP headers — avoids 403 on feeds that check User-Agent
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; EpiTrace-Scraper/1.0; "
        "+https://github.com/BreRoz/hantavirus)"
    ),
    "Accept": "application/rss+xml, application/xml, text/xml, */*",
}

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
# Seen-URL cache

def _load_seen():
    try:
        with open(SEEN_F) as f:
            return set(json.load(f))
    except Exception:
        return set()

def _save_seen(seen):
    with open(SEEN_F, "w") as f:
        json.dump(sorted(seen), f, indent=2)


# ---------------------------------------------------------------------------
# Fetch

def _fetch_feed(src):
    """Fetch an RSS feed with proper headers. Returns feedparser result."""
    url = src["url"]
    if _requests:
        try:
            resp = _requests.get(url, headers=_HEADERS, timeout=15)
            resp.raise_for_status()
            return feedparser.parse(resp.content)
        except Exception:
            pass  # fall back to feedparser direct fetch
    return feedparser.parse(url)


def _try_fetch_full_text(url):
    """Best-effort fetch of article full text (for better Claude extraction).
    Returns plain text up to 6000 chars, or empty string on failure."""
    if not _requests:
        return ""
    try:
        resp = _requests.get(url, headers=_HEADERS, timeout=10)
        resp.raise_for_status()
        html = resp.text
        # Very lightweight: strip tags, collapse whitespace
        import re
        text = re.sub(r"<[^>]+>", " ", html)
        text = re.sub(r"&[a-z]+;", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        return text[:6000]
    except Exception:
        return ""


def fetch_articles():
    """Pull all RSS sources, return new articles matching KEYWORDS."""
    articles = []
    if not feedparser:
        print("[Scraper] feedparser not installed — install it via requirements.txt")
        return articles

    seen = _load_seen()
    new_seen = set()

    for src in SOURCES:
        try:
            feed = _fetch_feed(src)
            for entry in feed.entries:
                url = entry.get("link", "")

                # Skip already-processed URLs
                if url in seen:
                    continue

                combined = " ".join([
                    entry.get("title", ""),
                    entry.get("summary", ""),
                    entry.get("description", ""),
                ]).lower()

                if not any(kw in combined for kw in KEYWORDS):
                    continue

                # Try to get full text; fall back to RSS summary
                summary = entry.get("summary", entry.get("description", ""))
                full_text = _try_fetch_full_text(url) if url else ""
                text = full_text if len(full_text) > len(summary) else summary
                text = text[:6000]

                articles.append({
                    "source_name": src["name"],
                    "title":       entry.get("title", ""),
                    "url":         url,
                    "text":        text,
                    "published":   entry.get("published", ""),
                })
                new_seen.add(url)

        except Exception as e:
            print(f"[Scraper] Error fetching {src['name']}: {e}")

    # Persist seen URLs (cap at 2000 to avoid unbounded growth)
    combined_seen = seen | new_seen
    if len(combined_seen) > 2000:
        combined_seen = set(sorted(combined_seen)[-2000:])
    _save_seen(combined_seen)

    print(f"[Scraper] {len(articles)} new matching article(s) found")
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
