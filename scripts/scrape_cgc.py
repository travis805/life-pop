#!/usr/bin/env python3
"""Scrape the CGC LIFE TCG population report into data/raw/cgc-<date>.json.

The public population pages (https://www.cgccards.com/population-report/tcg/life-tcg/55/) are
an Angular app. The data comes from CGC's own public JSON API, which the page calls itself:
  https://production.api.aws.ccg-ops.com/api/cards/research/trading-cards/
Eras (subcategories) -> sets (groups) -> cards (population). Sets are discovered, not hardcoded.

Output rows match the TAG file shape: {year,set,num,name,variant,grades:{label:count,TOTAL}}.
A sidecar cgc-<date>.meta.json holds the published per-set totals used for reconciliation.
"""
import datetime
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import lphttp  # noqa: E402

API = "https://production.api.aws.ccg-ops.com/api/cards/research/trading-cards"
GAME_ID = 55
ROOT = Path(__file__).resolve().parent.parent

# API column -> readable grade label
GRADE_COLS = {
    "population_Perfect10": "Perfect 10",
    "population_Pristine10": "Pristine 10",
    "population_GemMint10": "Gem Mint 10",
    "population_9_5": "9.5", "population_9_0": "9", "population_8_5": "8.5", "population_8_0": "8",
    "population_7_5": "7.5", "population_7_0": "7", "population_6_5": "6.5", "population_6_0": "6",
    "population_5_5": "5.5", "population_5_0": "5", "population_4_5": "4.5", "population_4_0": "4",
    "population_3_5": "3.5", "population_3_0": "3", "population_2_5": "2.5", "population_2_0": "2",
    "population_1_5": "1.5", "population_1_0": "1",
    "population_AU": "AU", "population_AA": "AA",
}


def jget(path):
    return json.loads(lphttp.get(API + path, accept="application/json"))


def main():
    date = datetime.date.today().isoformat()
    eras = jget(f"/subcategories/?researchCategoryID={GAME_ID}")
    rows, meta_sets = [], []
    for era in eras:
        era_id = era["researchSubcategoryID"]
        groups, page = [], 1
        while True:
            g = jget(f"/groups/?researchSubcategoryID={era_id}&page={page}")
            groups += g["Items"]
            if page >= g["PageCount"]:
                break
            page += 1
        for grp in groups:
            gid = grp["researchGroupID"]
            cards, page = [], 1
            while True:
                p = jget(f"/population/?researchGroupID={gid}&page={page}")
                cards += p["Items"]
                if page >= p["PageCount"]:
                    break
                page += 1
            total = 0
            for c in cards:
                grades = {lbl: c[col] for col, lbl in GRADE_COLS.items() if c.get(col)}
                known = sum(grades.values())
                if known != c["population_Total"]:
                    raise SystemExit(f"CGC {c['name']} {c['cardNumber']}: grade columns {known} != total {c['population_Total']}")
                grades["TOTAL"] = known
                total += known
                desc = (c.get("description") or "").strip()
                qual = (c.get("variant") or "").strip()
                rows.append({
                    "year": str(c["cardYear"]),
                    "set": grp["displayName"],
                    "era": era["name"],
                    "num": str(c["cardNumber"]).strip(),
                    "name": c["name"].strip(),
                    "variant": desc or None,
                    "qualifier": qual or None,
                    "grades": grades,
                })
            meta_sets.append({"era": era["name"], "set": grp["displayName"], "group_id": gid,
                              "published_total": grp["populationCount"], "scraped_total": total})
            print(f"  {grp['displayName']}: published {grp['populationCount']}, scraped {total}")
            if total != grp["populationCount"]:
                raise SystemExit(f"CGC set total mismatch for {grp['displayName']}")
    grand = sum(r["grades"]["TOTAL"] for r in rows)
    pub = sum(e["populationCount"] for e in eras)
    print(f"CGC total scraped {grand}, published (era sum) {pub}")
    if grand != pub:
        raise SystemExit("CGC grand total mismatch")
    out = ROOT / "data" / "raw" / f"cgc-{date}.json"
    out.write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")))
    (ROOT / "data" / "raw" / f"cgc-{date}.meta.json").write_text(json.dumps({
        "grader": "CGC", "date": date, "source_url": "https://www.cgccards.com/population-report/tcg/life-tcg/55/",
        "published_total": pub, "sets": meta_sets}, indent=1))
    print("wrote", out)


if __name__ == "__main__":
    main()
