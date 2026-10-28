#!/usr/bin/env python3
"""Build data/my_certs.csv (Travis's own slabs, all graders) from the private source files in data/private/.

Sources (one file per pull, add more graders by adding a parser below):
  data/private/tag-orders-*.txt   TAG order history, pipe-delimited: cert|name|grade|year|set|num|variant|order
                                  ('#' lines are comments). Pull it in Chrome on my.taggrading.com with 200 rows per page
                                  and Show All Grades.
  data/private/cgc-*.csv          CGC invoice export (My Submissions > invoice > export).
Output columns: cert,grader,set,num,name,variant,grade. set/num/name/variant use the grader's OWN labels, so
build_db.py can match each cert through that grader's pop data. For CGC the variant column holds
"<variant> | <qualifier>" (for example "Rare | Box Topper"); the grade is the label the CGC pop report uses.
data/private/ and data/my_certs.csv hold cert numbers and are gitignored.

Usage: python3 scripts/export_my_certs.py
"""
import collections
import csv
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRIVATE = ROOT / "data" / "private"
OUT = ROOT / "data" / "my_certs.csv"
FIELDS = ["cert", "grader", "set", "num", "name", "variant", "grade"]


def tag_grade(text):
    """'10 GEM MINT' / '10 (988)' / '9 MINT' -> '10' / '10' / '9' (the TAG pop report has no separate Pristine label)."""
    m = re.match(r"\s*(\d+(?:\.\d)?)", str(text))
    if not m:
        raise ValueError(f"unrecognized TAG grade {text!r}")
    return m.group(1)


def parse_tag(path):
    rows = []
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        cert, name, grade, _year, set_, num, variant, *_ = [p.strip() for p in line.split("|")] + [""] * 8
        rows.append({"cert": cert, "grader": "TAG", "set": set_, "num": num, "name": name,
                     "variant": variant, "grade": tag_grade(grade)})
    return rows


CGC_DESC = re.compile(r"^LIFE TCG English (?P<name>.+?) (?P<num>\d+(?:/\d+)?) (?P<year>\d{4}) (?P<set>.+?) - 1st Edition(?: (?P<rest>.*))?$")
CGC_VARIANTS = ("Full Art", "Extended Art", "Uncommon", "Common", "Holo", "Rare")


def cgc_grade(text):
    """Map the invoice grade to the label the CGC pop report uses (Gem Mint 10, Pristine 10, 9.5, 9, ...)."""
    t = str(text).strip().upper()
    if "PERFECT" in t:
        return "Perfect 10"
    if "PRISTINE" in t:
        return "Pristine 10"
    if "GEM MINT" in t:
        return "Gem Mint 10"
    m = re.search(r"(\d+(?:\.\d+)?)", t)
    if not m:
        raise ValueError(f"unrecognized CGC grade {text!r}")
    v = float(m.group(1))
    return str(int(v)) if v.is_integer() else str(v)


def parse_cgc(path):
    rows = []
    for r in csv.DictReader(open(path, newline="", encoding="utf-8-sig")):
        if not (r.get("Cert") or "").strip():
            continue
        m = CGC_DESC.match(r["Card Description"].strip())
        if not m:
            raise ValueError(f"unrecognized CGC description {r['Card Description']!r}")
        rest = (m.group("rest") or "").strip()
        variant = next((v for v in CGC_VARIANTS if rest == v or rest.startswith(v + " ")), "")
        qualifier = rest[len(variant):].strip()
        rows.append({
            "cert": re.sub(r"\.0$", "", r["Cert"].strip()), "grader": "CGC",
            "set": f"{m.group('set')} - 1st Edition - English", "num": m.group("num"), "name": m.group("name"),
            "variant": f"{variant} | {qualifier}" if qualifier else variant, "grade": cgc_grade(r["Grade"]),
        })
    return rows


PARSERS = [("tag-*.txt", parse_tag), ("cgc-*.csv", parse_cgc)]


def main():
    rows = []
    for pattern, parser in PARSERS:
        for f in sorted(PRIVATE.glob(pattern)):
            got = parser(f)
            print(f"  {f.name}: {len(got)} rows")
            rows += got
    certs = [r["cert"] for r in rows]
    dupes = [c for c, n in collections.Counter(certs).items() if n > 1]
    assert not dupes, f"duplicate cert numbers: {dupes}"
    OUT.parent.mkdir(exist_ok=True)
    with open(OUT, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} certs to {OUT}")
    for g, n in sorted(collections.Counter(r["grader"] for r in rows).items()):
        print(f"  {g}: {n}")


if __name__ == "__main__":
    main()
