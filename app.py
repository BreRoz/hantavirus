"""
Disease Surveillance & Contact Tracing — Flask Backend
MV Atlantic Star outbreak model with transmission chain, exposure events, and flight risk.
"""

import csv
import io
import json
import os
import threading
import time
import uuid
from datetime import datetime, timedelta

from flask import Flask, jsonify, render_template, request, Response

app = Flask(__name__)

BASE_DIR  = os.path.dirname(__file__)
DATA_DIR  = os.path.join(BASE_DIR, "data")
CASES_F   = os.path.join(DATA_DIR, "cases.json")
EXPOSE_F  = os.path.join(DATA_DIR, "exposure_events.json")
FLIGHTS_F = os.path.join(DATA_DIR, "flights.json")


# ---------------------------------------------------------------------------
# I/O helpers
# ---------------------------------------------------------------------------

def _load(path: str, default: dict) -> dict:
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def _save(path: str, data: dict) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def load_cases()    -> dict: return _load(CASES_F,   {"cases": [], "edges": []})
def load_exposures()-> dict: return _load(EXPOSE_F,  {"exposure_events": []})
def load_flights()  -> dict: return _load(FLIGHTS_F, {"flights": []})


# ---------------------------------------------------------------------------
# Seat risk model (WHO proximity guidelines)
# ---------------------------------------------------------------------------

_COL_INDEX = {c: i for i, c in enumerate("ABCDEFGHJ")}  # no I in aviation

def _col_idx(col: str) -> int:
    return _COL_INDEX.get(col.upper(), 0)

def calculate_seat_risk(case_seat: str, contact_seat: str,
                        duration_minutes: int) -> float:
    """Return 0–1 infection risk estimate based on seat proximity and flight duration."""
    try:
        case_row    = int("".join(c for c in case_seat    if c.isdigit()))
        contact_row = int("".join(c for c in contact_seat if c.isdigit()))
        case_col    = case_seat[-1].upper()
        contact_col = contact_seat[-1].upper()
    except (ValueError, IndexError):
        return 0.0

    row_diff = abs(case_row - contact_row)
    col_diff = abs(_col_idx(case_col) - _col_idx(contact_col))

    if row_diff == 0 and col_diff == 0:
        return 0.0          # same seat (is the case)
    elif row_diff == 0 and col_diff == 1:
        proximity = 0.90    # directly adjacent
    elif row_diff == 0 and col_diff <= 2:
        proximity = 0.70    # same row, close
    elif row_diff == 0:
        proximity = 0.35    # same row, across aisle
    elif row_diff == 1 and col_diff <= 1:
        proximity = 0.60    # one row, adjacent column
    elif row_diff == 1 and col_diff <= 3:
        proximity = 0.40    # one row, moderate distance
    elif row_diff == 1:
        proximity = 0.20    # one row, far
    elif row_diff == 2:
        proximity = 0.18
    elif row_diff == 3:
        proximity = 0.10
    else:
        proximity = 0.03

    # Scale by duration (reference = 7-hour flight = 420 min)
    duration_mod = min(1.0, duration_minutes / 420)
    return round(proximity * duration_mod, 3)


# ---------------------------------------------------------------------------
# Routes — UI
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# Routes — Cases
# ---------------------------------------------------------------------------

@app.route("/api/cases", methods=["GET"])
def get_cases():
    data   = load_cases()
    cases  = data["cases"]

    start          = request.args.get("start")
    end            = request.args.get("end")
    status_filter  = request.args.getlist("status")
    gen_filter     = [int(g) for g in request.args.getlist("generation") if g.isdigit()]

    if start:
        cases = [c for c in cases if c.get("date", "") >= start]
    if end:
        cases = [c for c in cases if c.get("date", "") <= end]
    if status_filter:
        cases = [c for c in cases if c.get("status") in status_filter]
    if gen_filter:
        cases = [c for c in cases if c.get("generation", 0) in gen_filter]

    ids    = {c["id"] for c in cases}
    edges  = [e for e in data["edges"] if e["source"] in ids and e["target"] in ids]
    return jsonify({"cases": cases, "edges": edges})


@app.route("/api/cases", methods=["POST"])
def add_case():
    data  = load_cases()
    case  = request.get_json(force=True)

    for f in ("date", "status", "location"):
        if f not in case:
            return jsonify({"error": f"Missing: {f}"}), 400

    case["id"]           = f"P{uuid.uuid4().hex[:6].upper()}"
    case.setdefault("onset_date",      case["date"])
    case.setdefault("incubation_start", "")
    case.setdefault("generation",      0)
    case.setdefault("infected_by",     None)
    case.setdefault("exposures",       [])
    case.setdefault("flights",         [])
    case.setdefault("ship_info",       None)
    case.setdefault("transport",       {"type": "none", "identifier": ""})
    case.setdefault("clinical_notes",  "")
    case.setdefault("reporter",        "Manual entry")

    data["cases"].append(case)
    _save(CASES_F, data)
    return jsonify(case), 201


@app.route("/api/cases/<cid>", methods=["GET"])
def get_case(cid):
    data = load_cases()
    c    = next((c for c in data["cases"] if c["id"] == cid), None)
    return jsonify(c) if c else (jsonify({"error": "Not found"}), 404)


@app.route("/api/cases/<cid>", methods=["PUT"])
def update_case(cid):
    data = load_cases()
    idx  = next((i for i, c in enumerate(data["cases"]) if c["id"] == cid), None)
    if idx is None:
        return jsonify({"error": "Not found"}), 404
    updated       = request.get_json(force=True)
    updated["id"] = cid
    data["cases"][idx] = updated
    _save(CASES_F, data)
    return jsonify(updated)


@app.route("/api/cases/<cid>", methods=["DELETE"])
def delete_case(cid):
    data   = load_cases()
    before = len(data["cases"])
    data["cases"] = [c for c in data["cases"] if c["id"] != cid]
    data["edges"] = [e for e in data["edges"]
                     if e["source"] != cid and e["target"] != cid]
    if len(data["cases"]) == before:
        return jsonify({"error": "Not found"}), 404
    _save(CASES_F, data)
    return jsonify({"deleted": cid})


# ---------------------------------------------------------------------------
# Routes — Edges
# ---------------------------------------------------------------------------

@app.route("/api/edges", methods=["POST"])
def add_edge():
    data = load_cases()
    edge = request.get_json(force=True)
    for f in ("source", "target", "type"):
        if f not in edge:
            return jsonify({"error": f"Missing: {f}"}), 400
    edge["id"] = f"E{uuid.uuid4().hex[:6].upper()}"
    edge.setdefault("event",            "")
    edge.setdefault("date",             datetime.now().strftime("%Y-%m-%d"))
    edge.setdefault("notes",            "")
    edge.setdefault("exposure_event_id", None)
    edge.setdefault("flight_id",        None)
    data["edges"].append(edge)
    _save(CASES_F, data)
    return jsonify(edge), 201


# ---------------------------------------------------------------------------
# Routes — Exposure Events
# ---------------------------------------------------------------------------

@app.route("/api/exposure-events", methods=["GET"])
def get_exposure_events():
    return jsonify(load_exposures())


@app.route("/api/exposure-events", methods=["POST"])
def add_exposure_event():
    data  = load_exposures()
    event = request.get_json(force=True)
    for f in ("type", "label", "transmission_risk"):
        if f not in event:
            return jsonify({"error": f"Missing: {f}"}), 400
    event["id"] = f"EXP{uuid.uuid4().hex[:6].upper()}"
    event.setdefault("risk_score",         0.5)
    event.setdefault("participants",       [])
    event.setdefault("location",           "")
    event.setdefault("deck",               None)
    event.setdefault("area",               "")
    event.setdefault("notes",              "")
    data["exposure_events"].append(event)
    _save(EXPOSE_F, data)
    return jsonify(event), 201


@app.route("/api/exposure-events/<eid>", methods=["DELETE"])
def delete_exposure_event(eid):
    data   = load_exposures()
    before = len(data["exposure_events"])
    data["exposure_events"] = [e for e in data["exposure_events"] if e["id"] != eid]
    if len(data["exposure_events"]) == before:
        return jsonify({"error": "Not found"}), 404
    _save(EXPOSE_F, data)
    return jsonify({"deleted": eid})


# ---------------------------------------------------------------------------
# Routes — Flights
# ---------------------------------------------------------------------------

@app.route("/api/flights", methods=["GET"])
def get_flights():
    return jsonify(load_flights())


@app.route("/api/flights/<fid>", methods=["GET"])
def get_flight(fid):
    data   = load_flights()
    flight = next((f for f in data["flights"] if f["id"] == fid), None)
    return jsonify(flight) if flight else (jsonify({"error": "Not found"}), 404)


@app.route("/api/flights/<fid>/risk", methods=["GET"])
def get_flight_risk(fid):
    """Compute seat-proximity risk for every contact on a flight."""
    flight_data = load_flights()
    flight      = next((f for f in flight_data["flights"] if f["id"] == fid), None)
    if not flight:
        return jsonify({"error": "Not found"}), 404

    duration    = flight.get("duration_minutes", 360)
    manifest    = flight.get("manifest", [])

    # Collect infectious case seats
    infectious_seats = [
        e["seat"] for e in manifest
        if e.get("type") == "case" and e.get("infectious", False)
    ]

    # Compute risk for every contact row
    for entry in manifest:
        if entry.get("type") == "contact":
            max_risk = 0.0
            for inf_seat in infectious_seats:
                r = calculate_seat_risk(inf_seat, entry["seat"], duration)
                max_risk = max(max_risk, r)
            entry["risk_score"] = max_risk
        elif entry.get("type") == "case":
            entry["risk_score"] = 1.0  # source

    return jsonify({"flight": flight, "infectious_seats": infectious_seats})


# ---------------------------------------------------------------------------
# Routes — Transmission Chain Graph
# ---------------------------------------------------------------------------

@app.route("/api/transmission-chain", methods=["GET"])
def get_transmission_chain():
    """Return a multi-type graph: case nodes + exposure nodes + flight nodes."""
    cases_data   = load_cases()
    expose_data  = load_exposures()
    flights_data = load_flights()

    nodes, edges = [], []

    # Case nodes
    for c in cases_data["cases"]:
        nodes.append({
            "id":         c["id"],
            "type":       "case",
            "label":      c["id"],
            "generation": c.get("generation", 0),
            "status":     c.get("status", "suspected"),
            "onset_date": c.get("onset_date", ""),
            "date":       c.get("date", ""),
            "city":       c.get("location", {}).get("city", ""),
            "country":    c.get("location", {}).get("country", ""),
            "infected_by": c.get("infected_by"),
        })
        if c.get("infected_by"):
            edges.append({
                "id":     f"inf_{c['infected_by']}_{c['id']}",
                "source": c["infected_by"],
                "target": c["id"],
                "type":   "infected_by",
                "label":  "infected",
            })

    # Exposure event nodes + edges
    include_exposure = request.args.get("include_exposure", "true").lower() == "true"
    if include_exposure:
        for ev in expose_data.get("exposure_events", []):
            nodes.append({
                "id":    ev["id"],
                "type":  "exposure",
                "label": ev.get("label", ev["id"]),
                "risk":  ev.get("transmission_risk", ""),
                "deck":  ev.get("deck"),
                "area":  ev.get("area", ""),
                "date":  ev.get("date_start", ""),
            })
            for pid in ev.get("participants", []):
                edges.append({
                    "id":     f"exp_{pid}_{ev['id']}",
                    "source": pid,
                    "target": ev["id"],
                    "type":   "exposed_to",
                    "label":  "",
                })

    # Flight nodes + edges
    include_flights = request.args.get("include_flights", "true").lower() == "true"
    if include_flights:
        for fl in flights_data.get("flights", []):
            nodes.append({
                "id":    fl["id"],
                "type":  "flight",
                "label": fl["flight_number"],
                "date":  fl.get("date", ""),
                "from":  fl.get("departure_airport", ""),
                "to":    fl.get("arrival_airport", ""),
            })
            for entry in fl.get("manifest", []):
                if entry.get("type") == "case" and entry.get("passenger_id"):
                    edges.append({
                        "id":     f"fl_{entry['passenger_id']}_{fl['id']}",
                        "source": entry["passenger_id"],
                        "target": fl["id"],
                        "type":   "traveled_on",
                        "label":  entry.get("seat", ""),
                    })

    return jsonify({"nodes": nodes, "edges": edges})


# ---------------------------------------------------------------------------
# Routes — Timeline Data
# ---------------------------------------------------------------------------

@app.route("/api/timeline", methods=["GET"])
def get_timeline():
    cases_data   = load_cases()
    flights_data = load_flights()

    flights_by_id = {f["id"]: f for f in flights_data.get("flights", [])}

    rows = []
    for c in cases_data["cases"]:
        onset   = c.get("onset_date", c.get("date", ""))
        inc_start = c.get("incubation_start", "")
        if not inc_start and onset:
            try:
                dt = datetime.strptime(onset, "%Y-%m-%d") - timedelta(days=14)
                inc_start = dt.strftime("%Y-%m-%d")
            except ValueError:
                inc_start = ""

        flight_events = []
        for fl_entry in c.get("flights", []):
            fl = flights_by_id.get(fl_entry["flight_id"], {})
            if fl:
                flight_events.append({
                    "flight_id":     fl_entry["flight_id"],
                    "flight_number": fl.get("flight_number", ""),
                    "date":          fl.get("date", ""),
                    "from":          fl.get("departure_airport", ""),
                    "to":            fl.get("arrival_airport", ""),
                    "seat":          fl_entry.get("seat", ""),
                    "infectious":    fl_entry.get("infectious", False),
                })

        rows.append({
            "id":             c["id"],
            "name":           c.get("name", c["id"]),
            "generation":     c.get("generation", 0),
            "status":         c.get("status", "suspected"),
            "date":           c.get("date", ""),
            "onset_date":     onset,
            "incubation_start": inc_start,
            "infected_by":    c.get("infected_by"),
            "ship_info":      c.get("ship_info"),
            "flights":        flight_events,
            "exposures":      c.get("exposures", []),
        })

    rows.sort(key=lambda r: r.get("onset_date", ""))
    return jsonify({"timeline": rows})


# ---------------------------------------------------------------------------
# Routes — Stats
# ---------------------------------------------------------------------------

@app.route("/api/stats", methods=["GET"])
def get_stats():
    cases   = load_cases()["cases"]
    expose  = load_exposures()["exposure_events"]
    flights = load_flights()["flights"]
    statuses = ["confirmed", "suspected", "recovered", "deceased"]
    stats = {s: sum(1 for c in cases if c.get("status") == s) for s in statuses}
    stats["total"]             = len(cases)
    stats["exposure_events"]   = len(expose)
    stats["flights"]           = len(flights)
    stats["generations"]       = {}
    for c in cases:
        g = str(c.get("generation", 0))
        stats["generations"][g] = stats["generations"].get(g, 0) + 1
    return jsonify(stats)


# ---------------------------------------------------------------------------
# Routes — CSV Import
# ---------------------------------------------------------------------------

@app.route("/api/import", methods=["POST"])
def import_csv():
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    content = request.files["file"].read().decode("utf-8-sig")
    reader  = csv.DictReader(io.StringIO(content))
    data    = load_cases()
    imported, errors = 0, []
    for i, row in enumerate(reader, 2):
        try:
            case = {
                "id":         f"P{uuid.uuid4().hex[:6].upper()}",
                "name":       row.get("name", "Unknown"),
                "age":        int(row["age"]) if row.get("age") else None,
                "sex":        row.get("sex", ""),
                "generation": int(row.get("generation", 0)),
                "infected_by": row.get("infected_by") or None,
                "date":        row.get("date", datetime.now().strftime("%Y-%m-%d")),
                "onset_date":  row.get("onset_date", row.get("date", "")),
                "incubation_start": row.get("incubation_start", ""),
                "location": {
                    "lat":     float(row.get("lat", 0)),
                    "lng":     float(row.get("lng", 0)),
                    "city":    row.get("city", ""),
                    "state":   row.get("state", ""),
                    "country": row.get("country", ""),
                    "venue":   row.get("venue", ""),
                },
                "transport": {
                    "type":       row.get("transport_type", "none"),
                    "identifier": row.get("transport_id", ""),
                },
                "ship_info":     None,
                "exposures":     [],
                "flights":       [],
                "status":        row.get("status", "suspected"),
                "clinical_notes": row.get("clinical_notes", ""),
                "reporter":      row.get("reporter", "CSV import"),
            }
            data["cases"].append(case)
            imported += 1
        except Exception as exc:
            errors.append(f"Row {i}: {exc}")
    _save(CASES_F, data)
    return jsonify({"imported": imported, "errors": errors})


# ---------------------------------------------------------------------------
# Routes — Export
# ---------------------------------------------------------------------------

@app.route("/api/export/cases", methods=["GET"])
def export_cases_csv():
    cases_data  = load_cases()
    expose_data = load_exposures()
    exp_lookup  = {e["id"]: e for e in expose_data.get("exposure_events", [])}

    buf     = io.StringIO()
    writer  = csv.writer(buf)
    headers = [
        "id", "name", "age", "sex", "nationality",
        "generation", "infected_by", "status",
        "date", "onset_date", "incubation_start",
        "city", "country", "venue",
        "ship_cabin", "ship_deck", "ship_role",
        "transport_type", "transport_id",
        "clinical_notes", "reporter",
        "exposure_count", "exposure_summary",
    ]
    writer.writerow(headers)

    for c in cases_data["cases"]:
        loc      = c.get("location", {})
        ship     = c.get("ship_info") or {}
        tr       = c.get("transport", {})
        exp_ids  = c.get("exposures", [])
        exp_summary = "; ".join(
            exp_lookup.get(eid, {}).get("label", eid) for eid in exp_ids
        )
        writer.writerow([
            c["id"], c.get("name",""), c.get("age",""), c.get("sex",""), c.get("nationality",""),
            c.get("generation",0), c.get("infected_by",""), c.get("status",""),
            c.get("date",""), c.get("onset_date",""), c.get("incubation_start",""),
            loc.get("city",""), loc.get("country",""), loc.get("venue",""),
            ship.get("cabin",""), ship.get("deck",""), ship.get("role",""),
            tr.get("type",""), tr.get("identifier",""),
            c.get("clinical_notes",""), c.get("reporter",""),
            len(exp_ids), exp_summary,
        ])

    return Response(
        buf.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=cases_export.csv"},
    )


@app.route("/api/export/transmission", methods=["GET"])
def export_transmission_json():
    cases_data   = load_cases()
    expose_data  = load_exposures()
    flights_data = load_flights()

    chain = {
        "generated_at": datetime.now().isoformat(),
        "vessel":        "MV Atlantic Star",
        "cases":         cases_data["cases"],
        "edges":         cases_data["edges"],
        "exposure_events": expose_data["exposure_events"],
        "flights":       flights_data["flights"],
    }
    return Response(
        json.dumps(chain, indent=2, ensure_ascii=False),
        mimetype="application/json",
        headers={"Content-Disposition": "attachment; filename=transmission_chain.json"},
    )


@app.route("/api/export/flight/<fid>", methods=["GET"])
def export_flight_manifest(fid):
    flights_data = load_flights()
    flight       = next((f for f in flights_data["flights"] if f["id"] == fid), None)
    if not flight:
        return jsonify({"error": "Not found"}), 404

    duration = flight.get("duration_minutes", 360)
    infectious_seats = [
        e["seat"] for e in flight["manifest"]
        if e.get("type") == "case" and e.get("infectious", False)
    ]

    buf    = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "passenger_id", "name", "seat", "type", "status",
        "risk_score", "risk_level", "infectious",
        "nearest_case_seat", "onset_after_flight",
    ])

    for entry in flight["manifest"]:
        if entry.get("type") == "case":
            risk     = 1.0
            r_level  = "source"
        else:
            risk = max(
                (calculate_seat_risk(cs, entry["seat"], duration) for cs in infectious_seats),
                default=0.0,
            )
            if risk >= 0.5:   r_level = "high"
            elif risk >= 0.25: r_level = "medium"
            elif risk >= 0.1:  r_level = "low"
            else:              r_level = "minimal"

        writer.writerow([
            entry.get("passenger_id",""),
            entry.get("name",""),
            entry.get("seat",""),
            entry.get("type",""),
            entry.get("status",""),
            risk,
            r_level,
            entry.get("infectious", False),
            infectious_seats[0] if infectious_seats else "",
            entry.get("onset_after_flight", False),
        ])

    fname = f"manifest_{flight['flight_number']}_{flight['date']}.csv"
    return Response(
        buf.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename={fname}"},
    )


# ---------------------------------------------------------------------------
# Routes — Folium Map Export
# ---------------------------------------------------------------------------

@app.route("/api/map/export", methods=["GET"])
def export_map():
    try:
        import folium
    except ImportError:
        return jsonify({"error": "folium not installed"}), 501

    data   = load_cases()
    colors = {"confirmed": "red", "suspected": "orange",
              "recovered": "green", "deceased": "gray"}

    m = folium.Map(location=[30, 0], zoom_start=2, tiles="CartoDB dark_matter")
    for c in data["cases"]:
        loc = c.get("location", {})
        if not loc.get("lat") or not loc.get("lng"):
            continue
        folium.CircleMarker(
            location=[loc["lat"], loc["lng"]], radius=8,
            color=colors.get(c.get("status","suspected"), "gray"),
            fill=True, fill_opacity=0.8,
            popup=folium.Popup(
                f"<b>{c['id']}</b> Gen {c.get('generation',0)}<br>"
                f"{loc.get('city','')} · {c.get('onset_date','')}", max_width=220
            ),
        ).add_to(m)

    return m._repr_html_(), 200, {"Content-Type": "text/html"}


# ---------------------------------------------------------------------------
# Routes — Scraper

@app.route("/api/scraper/run", methods=["POST"])
def scraper_run():
    """Trigger a manual scrape cycle."""
    try:
        from scraper import run as _run
        result = _run()
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/scraper/log", methods=["GET"])
def scraper_log():
    log_path = os.path.join(DATA_DIR, "scraper_log.json")
    try:
        with open(log_path) as f:
            return jsonify(json.load(f))
    except Exception:
        return jsonify({"runs": []})


# ---------------------------------------------------------------------------
# Background scheduler — runs scraper once every 24 hours

def _scraper_loop():
    time.sleep(30)  # give Flask a moment to finish starting up
    while True:
        try:
            from scraper import run as _run
            _run()
        except Exception as e:
            print(f"[Scheduler] Scraper error: {e}")
        time.sleep(86400)  # 24 hours


def _start_scheduler():
    t = threading.Thread(target=_scraper_loop, daemon=True, name="scraper")
    t.start()


# ---------------------------------------------------------------------------

if __name__ == "__main__":
    _start_scheduler()
    port = int(os.environ.get("PORT", 5001))
    app.run(debug=False, host="0.0.0.0", port=port)
