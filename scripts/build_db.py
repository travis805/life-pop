#!/usr/bin/env python3
"""Build data/life_pop.sqlite and data/d1_load.sql from every snapshot on disk.

Inputs (all of them, every run, so history is kept):
  data/raw/<grader>-<YYYY-MM-DD>.json   scraper / browser output, rows {year,set,num,name,variant,grades}
  data/manual/<grader>.csv              snapshot_date,set,num,name,variant,grade,count
  data/my_certs.csv                     Travis's own TAG certs (scripts/export_my_certs.py)
Outputs:
  data/life_pop.sqlite   local copy (gitignored)
  data/d1_load.sql       idempotent full reload: DELETE everything, then INSERT. Safe to re-run:
                         wrangler d1 execute life-pop --remote --file data/d1_load.sql
  data/alias_report.txt  sets/cards that needed a judgment call (fuzzy, ambiguous, created)
Card identity is (canonical set, normalized number, normalized name, variant). Unmatched rows are
never dropped: a canonical card is created and listed in the report.
"""
import collections
import csv
import glob
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

GRADERS = [  # code, name, url, method
    ("CGC", "CGC Cards", "https://www.cgccards.com/population-report/tcg/life-tcg/55/", "scrape"),
    ("AGS", "AGS (Robograding)", "https://app.agscard.com/pop/categories/102", "scrape"),
    ("TAG", "TAG Grading", "https://my.taggrading.com/pop-report/Nature", "browser"),
    ("PSA", "PSA", "https://www.psacard.com/pop", "manual"),
    ("BGS", "Beckett (BGS)", "https://www.beckett.com/grading/pop-report", "browser"),
    ("SGC", "SGC", "https://gosgc.com/population-report", "manual"),
    ("ACE", "ACE Grading", "https://acegrading.com/pop", "browser"),
]
GRADER_URL = {g[0]: g[2] for g in GRADERS}

# canonical sets: name -> (year, sort_order)
SETS = {
    "Mammals 1st Edition": (2023, 1),
    "Mammals 1st Edition (Kickstarter)": (2022, 2),
    "Mammals Special Edition": (2026, 3),
    "Birds 1st Edition": (2025, 4),
    "Promos": (None, 5),
    "Mammals Photography": (2026, 6),
}
# Manual CSV file stems that differ from the grader code.
STEM_TO_CODE = {"BECKETT": "BGS"}
AUTH_EXACT = {"au", "aa", "cc", "va", "a", "auth", "authentic", "altered", "ae"}


def is_authentic(label):
    """Authentic-only slabs: graded (they count in totals) but no numeric grade, so no gem rate."""
    l = label.strip().lower()
    return l in AUTH_EXACT or "authentic" in l or "altered" in l or l.startswith("auth")


def is_gem(grader, numeric):
    """Gem tier: 10 and above everywhere, except BGS where 9.5 Gem Mint and up counts."""
    return numeric >= (9.5 if grader == "BGS" else 10)


# AGS never states a variant; TAG's pop page leaves it blank for many holo cards. For these graders
# a blank variant means "unspecified": attach to the existing card instead of inventing a Base one.
UNSPECIFIED_OK = {"AGS", "TAG", "BGS", "ACE", "PSA", "SGC"}
# Process graders that state a variant first, so AGS (variant usually unstated) attaches to existing cards.
GRADER_ORDER = ["CGC", "TAG", "PSA", "BGS", "SGC", "ACE", "AGS"]


# ---------- normalization ----------
def set_for(raw_set, num_norm, variant=""):
    """Map a grader's set label to a canonical set name (None when unrecognized)."""
    s = raw_set.lower()
    if "photograph" in s:
        return "Mammals Photography"
    if "promo" in s:
        # BGS files the 2026 Photography cards under "Promos" with variant "Photography".
        return "Mammals Photography" if (variant or "").strip().lower() == "photography" else "Promos"
    if "bird" in s:
        return "Birds 1st Edition"
    if "special edition" in s:
        return "Mammals Special Edition"
    if "kickstarter" in s or re.search(r"\bks\b", s):
        return "Mammals 1st Edition (Kickstarter)"
    if "mammal" in s or re.match(r"2023 life\b", s):  # AGS files signed Mammals 1st Edition cards under "2023 LIFE"
        # Numbers above 100 in the main Mammals set are promo-numbered cards (TAG files them as Promo).
        return "Promos" if num_norm.isdigit() and int(num_norm) > 100 else "Mammals 1st Edition"
    return None


def norm_num(raw):
    s = str(raw or "").strip().split("/")[0].strip()
    if not re.fullmatch(r"\d+", s):
        return ""
    return str(int(s))


def norm_name(raw):
    return re.sub(r"[^a-z0-9]", "", str(raw).lower())


def pretty_name(raw):
    n = raw.strip()
    if n.isupper():
        n = re.sub(r"'S\b", "'s", n.title())
    return n


def norm_variant(desc, qualifier, grader):
    """Return a canonical variant, or None when the grader does not state one (AGS)."""
    d = (desc or "").strip()
    q = re.sub(r"^1st Edition\s*", "", (qualifier or "").strip(), flags=re.I).strip()
    if not d and not q and grader in UNSPECIFIED_OK:
        return None
    dl = d.lower().replace("-", " ")
    base = {"": "Base", "rare": "Base", "base": "Base", "holo": "Holo", "full art": "Full Art",
            "extended art": "Extended Art", "uncommon": "Uncommon", "common": "Common"}.get(dl, d)
    if q:
        return q if base == "Base" else f"{base} - {q}"
    return base


def grade_numeric(label):
    l = label.lower()
    if "perfect" in l:
        return 10.75
    if any(k in l for k in ("pristine", "legend", "10p", "black label")):
        return 10.5
    m = re.search(r"(\d+(?:\.\d+)?)", l)
    if not m:
        return 0.0
    # AGS "plus" half-grades ("9+") sit half a point above their base grade; 10+ would count as gem tier.
    return float(m.group(1)) + (0.5 if l.endswith("+") else 0.0)  # AU, AA, CC, VA: authentic / no numeric grade


# ---------- card registry ----------
class Registry:
    def __init__(self):
        self.cards = {}  # (set, num, nn, variant) -> dict
        self.by_num = collections.defaultdict(list)
        self.by_name = collections.defaultdict(list)
        self.aliases = {}  # (grader, raw_set, raw_num, raw_name, raw_variant) -> (card, kind)
        self.report = collections.defaultdict(list)

    def _new(self, s, n, name, variant):
        key = (s, n, norm_name(name), variant)
        c = {"set": s, "number": n, "name": pretty_name(name), "variant": variant}
        self.cards[key] = c
        self.by_num[(s, n, key[2])].append(c)
        self.by_name[(s, key[2])].append(c)
        return c

    def resolve(self, grader, raw_set, raw_num, raw_name, desc, qualifier):
        n = norm_num(raw_num)
        if "foil" in raw_set.lower() and not (desc or "").strip():
            desc = "Holo"  # BGS "Mammals 1st Edition Foil" holds the holos; plain "Mammals 1st Edition" is the base card
        s = set_for(raw_set, n, desc)
        if s is None:
            s = f"Unmapped: {raw_set}"
            if s not in SETS:
                SETS[s] = (None, 90 + len([k for k in SETS if k.startswith('Unmapped')]))
                self.report["Unmapped set labels (new canonical set created)"].append(f"{grader}: {raw_set}")
        v = norm_variant(desc, qualifier, grader)
        nn = norm_name(raw_name)
        cands = list(self.by_num[(s, n, nn)] if n else self.by_name[(s, nn)])
        kind = "exact"
        if v is None:  # variant not stated by the grader
            if len(cands) == 1:
                card = cands[0]
                kind = "exact" if card["variant"] == "Base" else "fuzzy"
            elif len(cands) > 1:
                card = next((c for c in cands if c["variant"] == "Base"), None) or \
                    next((c for c in cands if c["variant"] == "Holo"), cands[0])
                kind = "ambiguous"
            else:
                card, kind = self._new(s, n, raw_name, "Base"), "created"
        else:
            card = next((c for c in cands if c["variant"] == v), None)
            if card is None:
                card, kind = self._new(s, n, raw_name, v), "created"
        akey = (grader, raw_set, str(raw_num or ""), raw_name, ((desc or "") + (" | " + qualifier if qualifier else "")))
        if akey not in self.aliases:
            self.aliases[akey] = (card, kind)
            label = f"{grader} {raw_set} #{raw_num} {raw_name} [{akey[4] or '-'}] -> {card['set']} #{card['number']} {card['name']} [{card['variant']}]"
            if kind in ("fuzzy", "ambiguous"):
                self.report[f"{kind.capitalize()} matches"].append(label)
            elif kind == "created" and grader != GRADER_ORDER[0]:
                self.report[f"Canonical card created from {grader} (not in an earlier-processed source)"].append(label)
        return card


# ---------- loading ----------
def load_raw():
    out = []  # (grader, date, rows)
    for f in sorted(glob.glob(str(DATA / "raw" / "*.json"))):
        m = re.fullmatch(r"([a-z]+)-(\d{4}-\d{2}-\d{2})\.json", os.path.basename(f))
        if not m:
            continue
        out.append((m.group(1).upper(), m.group(2), json.load(open(f))))
    return out


def load_manual():
    out = []
    for f in sorted(glob.glob(str(DATA / "manual" / "*.csv"))):
        grader = STEM_TO_CODE.get(Path(f).stem.upper(), Path(f).stem.upper())
        by_date = collections.defaultdict(lambda: collections.defaultdict(lambda: {"grades": {}}))
        for r in csv.DictReader(open(f, newline="")):
            if not (r.get("snapshot_date") or "").strip():
                continue
            key = (r["set"].strip(), r["num"].strip(), r["name"].strip(), (r.get("variant") or "").strip())
            row = by_date[r["snapshot_date"].strip()][key]
            row["grades"][r["grade"].strip()] = row["grades"].get(r["grade"].strip(), 0) + int(r["count"])
        for d, rows in by_date.items():
            out.append((grader, d, [{"year": "", "set": k[0], "num": k[1], "name": k[2], "variant": k[3] or None,
                                     "grades": {**v["grades"], "TOTAL": sum(v["grades"].values())}} for k, v in rows.items()]))
    return out


def main():
    snaps = load_raw() + load_manual()
    snaps.sort(key=lambda s: (GRADER_ORDER.index(s[0]) if s[0] in GRADER_ORDER else 50, s[1]))
    reg = Registry()
    pop = collections.defaultdict(int)  # (date, grader, card_key, label) -> count
    snapshot_rows, src_totals, raw_totals = {}, collections.defaultdict(int), collections.defaultdict(int)  # src_totals[(grader,date,canon set)]
    for grader, date, rows in snaps:
        total = 0
        # rows that state a variant first, so blank-variant rows attach to them
        rows = sorted(rows, key=lambda r: norm_variant(r.get("variant"), r.get("qualifier"), grader) is None)
        for r in rows:
            g = {k: v for k, v in r["grades"].items() if k != "TOTAL"}
            if sum(g.values()) != r["grades"].get("TOTAL", sum(g.values())):
                sys.exit(f"{grader} {date}: grade sum != TOTAL for {r['name']}")
            card = reg.resolve(grader, r["set"], r["num"], r["name"], r.get("variant"), r.get("qualifier"))
            for label, cnt in g.items():
                pop[(date, grader, id(card), label)] += cnt
                total += cnt
                src_totals[(grader, date, card["set"])] += cnt
                raw_totals[(grader, date, r["set"])] += cnt
        snapshot_rows[(date, grader)] = total

    # deterministic ids
    set_names = sorted(SETS, key=lambda n: SETS[n][1])
    set_id = {n: i + 1 for i, n in enumerate(set_names)}
    cards = sorted(reg.cards.values(), key=lambda c: (SETS[c["set"]][1], int(c["number"] or 9999), c["name"].lower(), c["variant"]))
    for i, c in enumerate(cards, 1):
        c["id"] = i

    # my certs (TAG), matched like any TAG row
    certs, cert_problems = [], []
    cert_file = DATA / "my_certs.csv"
    if cert_file.exists():
        for r in csv.DictReader(open(cert_file, newline="")):
            card = reg.resolve("TAG", r["set"], r["num"], r["name"], r["variant"] or None, None)
            certs.append((r["cert"], r["grader"] or "TAG", card, r["grade"]))
        need = collections.Counter((id(c), g) for _, _, c, g in certs)
        tag_dates = [d for (g, d, _) in src_totals if g == "TAG"]
        latest_tag = max(tag_dates) if tag_dates else None
        for (cid, g), n in need.items():
            have = pop.get((latest_tag, "TAG", cid, g), 0)
            if have < n:
                card = next(c for c in reg.cards.values() if id(c) == cid)
                cert_problems.append(f"{card['set']} #{card['number']} {card['name']} [{card['variant']}] grade {g}: {n} certs, TAG pop {have}")
        if cert_problems:
            reg.report["My certs exceeding TAG pop (cert grade missing or card mismatch)"] += cert_problems
        # cards created for certs need ids too
        for c in reg.cards.values():
            if "id" not in c:
                cards.append(c)
        for i, c in enumerate(cards, 1):
            c["id"] = i

    # ---------- write sqlite ----------
    db_path = DATA / "life_pop.sqlite"
    if db_path.exists():
        db_path.unlink()
    db = sqlite3.connect(db_path)
    db.executescript((ROOT / "schema.sql").read_text())
    db.executemany("INSERT INTO graders VALUES (?,?,?,?)", GRADERS)
    db.executemany("INSERT INTO sets VALUES (?,?,?,?)", [(set_id[n], n, SETS[n][0], SETS[n][1]) for n in set_names])
    db.executemany("INSERT INTO cards VALUES (?,?,?,?,?)", [(c["id"], set_id[c["set"]], c["number"], c["name"], c["variant"]) for c in cards])
    db.executemany("INSERT INTO card_aliases VALUES (?,?,?,?,?,?,?)",
                   [(*k, c["id"], kind) for k, (c, kind) in sorted(reg.aliases.items())])
    by_id = {id(c): c for c in cards}
    pop_rows = []
    for (date, grader, cid, label), cnt in sorted(pop.items(), key=lambda kv: (kv[0][0], kv[0][1], by_id[kv[0][2]]["id"], kv[0][3])):
        num = grade_numeric(label)
        auth = is_authentic(label)
        pop_rows.append((date, grader, by_id[cid]["id"], label, num, 1 if (not auth and is_gem(grader, num)) else 0, 1 if auth else 0, cnt))
    db.executemany("INSERT INTO pop VALUES (?,?,?,?,?,?,?,?)", pop_rows)
    db.executemany("INSERT INTO my_certs VALUES (?,?,?,?)", [(cert, g, c["id"], gr) for cert, g, c, gr in certs])
    notes = {}
    for f in glob.glob(str(DATA / "raw" / "*.meta.json")):
        meta = json.load(open(f))
        if meta.get("published_total") is not None:
            notes[(meta["date"], meta["grader"])] = f"Source reported {meta['published_total']} graded" + (" (grade plus half-grade '+' rows)" if meta["grader"] == "AGS" else "")
    db.executemany("INSERT INTO snapshots VALUES (?,?,?,?,?)",
                   [(d, g, GRADER_URL.get(g), t, notes.get((d, g))) for (d, g), t in sorted(snapshot_rows.items())])
    db.commit()

    # ---------- d1_load.sql ----------
    def lit(v):
        if v is None:
            return "NULL"
        if isinstance(v, (int, float)):
            return repr(v) if isinstance(v, float) and not v.is_integer() else str(int(v)) if float(v).is_integer() else repr(v)
        return "'" + str(v).replace("'", "''") + "'"
    lines = ["-- Generated by scripts/build_db.py. Full reload, safe to re-run.",
             "-- wrangler d1 execute life-pop --remote --file data/d1_load.sql"]
    for t in ("pop", "my_certs", "card_aliases", "snapshots", "cards", "sets", "graders"):
        lines.append(f"DELETE FROM {t};")
    for t in ("graders", "sets", "cards", "card_aliases", "snapshots", "pop", "my_certs"):
        cols = [r[1] for r in db.execute(f"PRAGMA table_info({t})")]
        order = {"pop": "snapshot_date, grader, card_id, grade_label", "card_aliases": "grader, raw_set, raw_num, raw_name, raw_variant"}.get(t, "1")
        for row in db.execute(f"SELECT * FROM {t} ORDER BY {order}"):
            lines.append(f"INSERT OR REPLACE INTO {t} ({', '.join(cols)}) VALUES ({', '.join(lit(v) for v in row)});")
    (DATA / "d1_load.sql").write_text("\n".join(lines) + "\n")
    (DATA / "d1_migrate.sql").write_text(
        "-- One-time migration for a D1 database created from the first schema.sql (no authentic flag).\n"
        "-- Run once BEFORE d1_load.sql: wrangler d1 execute life-pop --remote --file data/d1_migrate.sql\n"
        "-- (fails with 'duplicate column name' if already applied, which is harmless.)\n"
        "ALTER TABLE pop ADD COLUMN is_authentic INTEGER NOT NULL DEFAULT 0;\n")

    # ---------- report ----------
    rep = []
    for title, items in reg.report.items():
        rep.append(f"## {title} ({len(items)})")
        rep += [f"  {i}" for i in items]
    (DATA / "alias_report.txt").write_text("\n".join(rep) + "\n")

    print(f"cards {len(cards)}, sets {len(set_names)}, pop rows {len(pop_rows)}, aliases {len(reg.aliases)}, certs {len(certs)}")
    print("\nSnapshots:")
    for (d, g), t in sorted(snapshot_rows.items()):
        print(f"  {d} {g:8} {t}")
    print("\nReconciliation (loaded vs source-published), latest snapshot per grader:")
    metas = {}
    for f in glob.glob(str(DATA / "raw" / "*.meta.json")):
        m = json.load(open(f))
        metas[(m["grader"], m["date"])] = m
    latest = {}
    for (d, g) in snapshot_rows:
        latest[g] = max(latest.get(g, ""), d)
    for g, d in sorted(latest.items()):
        m = metas.get((g, d))
        head = f"  {g} {d}: loaded {snapshot_rows[(d, g)]}"
        if m and m.get("published_total") is not None:
            head += f", page headline {m['published_total']}"
        print(head)
        pub = {s["set"]: s["published_total"] for s in m["sets"]} if m else {}
        for rs in sorted(k[2] for k in raw_totals if k[0] == g and k[1] == d):
            ld = raw_totals[(g, d, rs)]
            if pub:
                print(f"      source set {rs:40} loaded {ld:4}  published {pub.get(rs, 0):4}  {'OK' if pub.get(rs, 0) == ld else 'DIFF'}")
            else:
                print(f"      source set {rs:40} loaded {ld:4}  (no published figure)")
        print("      canonical sets: " + ", ".join(f"{s} {src_totals[(g, d, s)]}" for s in sorted({k[2] for k in src_totals if k[0] == g and k[1] == d}, key=lambda n: SETS[n][1])))
    print("\nReport written to data/alias_report.txt:")
    for title, items in reg.report.items():
        print(f"  {title}: {len(items)}")


if __name__ == "__main__":
    main()
