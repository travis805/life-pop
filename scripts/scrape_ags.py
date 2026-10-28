#!/usr/bin/env python3
"""Scrape the AGS (Robograding) LIFE TCG population report into data/raw/ags-<date>.json.

Server-rendered HTML at https://app.agscard.com/pop/categories/102 :
  category -> series (year / release) links -> set rows -> card rows (paginated, per_page=100).
Each grade cell shows "<count at this grade> <br> <count at higher grades>"; only the first
number is used. Series and set ids are discovered from the pages, not hardcoded.
"""
import datetime
import html
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import lphttp  # noqa: E402

BASE = "https://app.agscard.com"
CATEGORY = BASE + "/pop/categories/102"
ROOT = Path(__file__).resolve().parent.parent
# Column order on the AGS tables (after the label cell). The final cell is the row total.
GRADES = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "Gem-MT 10", "Legend 10", "AU", "AA", "CC"]


def clean(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def parse_cells(row_html):
    """Return ({grade: count}, total) from a table row."""
    cells = re.findall(r'<td class="pop-list__table-cell pop-list__table-cell--(value|total)">(.*?)</td>', row_html, flags=re.S)
    nums = []
    for _kind, c in cells:
        txt = clean(c)
        m = re.match(r"(\d+)", txt)
        nums.append(int(m.group(1)) if m else 0)
    if len(nums) != len(GRADES) + 1:
        raise SystemExit(f"AGS: expected {len(GRADES) + 1} value cells, got {len(nums)}")
    grades = {g: n for g, n in zip(GRADES, nums[:-1]) if n}
    if sum(grades.values()) != nums[-1]:
        raise SystemExit(f"AGS: grade sum {sum(grades.values())} != row total {nums[-1]}")
    return grades, nums[-1]


def data_rows(page_html):
    return re.findall(r'<tr class="pop-list__table-row">(.*?)</tr>', page_html, flags=re.S)


def variant_of(edition):
    """Best-effort variant from AGS's free-text edition label (None when not stated)."""
    e = (edition or "").upper()
    if "FULL ART" in e:
        return "Full Art"
    if "EXTENDED ART" in e:
        return "Extended Art"
    if "HOLO" in e:
        return "Holo"
    return None


def main():
    date = datetime.date.today().isoformat()
    cat = lphttp.get(CATEGORY)
    hero = re.findall(r'pop-hero__text-stat-column-value">\s*(\d+)\s*<', cat)  # sets, cards, graded
    series_ids = sorted(set(re.findall(r"/pop/categories/102/series/(\d+)", cat)))
    print("series:", series_ids, "hero stats (sets, cards, graded):", hero)
    rows, meta_sets = [], []
    for sid in series_ids:
        sp = lphttp.get(f"{CATEGORY}/series/{sid}")
        series_name = clean(re.findall(r'<h1 class="pop-hero__text-series-heading">(.*?)</h1>', sp, flags=re.S)[0])
        for row in data_rows(sp):
            m = re.search(r"/series/%s/sets/(\d+)" % sid, row)
            if not m:
                continue
            set_id = m.group(1)
            set_name = re.sub(r"\s*\d\d/\d\d/\d{4}\s*Grade.*$", "", clean(row.split("</td>")[0]))
            _g, set_total = parse_cells(row)
            year_m = re.search(r"(20\d\d)", set_name) or re.search(r"(20\d\d)", series_name)
            year = year_m.group(1) if year_m else ""
            scraped, page = 0, 0
            while True:
                url = f"{CATEGORY}/series/{sid}/sets/{set_id}?page={page}&per_page=100"
                p = lphttp.get(url)
                all_rows = data_rows(p)
                cards = all_rows
                cards = [c for c in cards if "<td" in c and "table-cell--card" in c]
                for c in cards:
                    heading = clean(re.search(r'info-heading display-desktop">(.*?)</p>', c, flags=re.S).group(1))
                    mob = clean(re.search(r'info-heading display-mobile">(.*?)</p>', c, flags=re.S).group(1))
                    num = clean(re.search(r'info-subheading display-mobile">(.*?)</p>', c, flags=re.S).group(1))
                    name = mob[: -len(heading)].strip() if heading and mob.endswith(heading) else mob
                    grades, total = parse_cells(c)
                    grades["TOTAL"] = total
                    scraped += total
                    if not total:  # AGS lists ungraded catalog cards too; keep only graded ones
                        continue
                    rows.append({"year": year, "set": set_name, "series": series_name, "num": num,
                                 "name": name, "variant": variant_of(heading), "edition": heading or None,
                                 "grades": grades})
                nxt = re.search(r'pagination__navigation__button--next', p)
                disabled = re.search(r'button__disabled pagination__navigation__button--next', p)
                if not cards or not nxt or disabled:
                    break
                page += 1
            meta_sets.append({"series": series_name, "set": set_name, "set_id": set_id,
                              "published_total": set_total, "scraped_total": scraped})
            print(f"  {series_name} / {set_name}: published {set_total}, scraped {scraped}")
            if set_total != scraped:
                raise SystemExit(f"AGS set total mismatch for {set_name}")
    grand = sum(r["grades"]["TOTAL"] for r in rows)
    hero_graded = int(hero[2]) if len(hero) >= 3 else None
    print(f"AGS total scraped {grand}; page hero says {hero_graded}")
    out = ROOT / "data" / "raw" / f"ags-{date}.json"
    out.write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")))
    (ROOT / "data" / "raw" / f"ags-{date}.meta.json").write_text(json.dumps({
        "grader": "AGS", "date": date, "source_url": CATEGORY, "published_total": hero_graded,
        "table_total": grand, "sets": meta_sets}, indent=1))
    print("wrote", out)


if __name__ == "__main__":
    main()
