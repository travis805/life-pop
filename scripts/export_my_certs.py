#!/usr/bin/env python3
"""Export Travis's own LIFE TCG TAG certs from the Grading Batches workbook to data/my_certs.csv.

Read-only on the workbook. Re-runnable. A row counts as LIFE when the BRAND column is "Life TCG"
(this skips the INELIGIBLE size-restriction rows on the 'LIFE TCG Test' sheet, which have no brand).
data/my_certs.csv holds cert numbers and is gitignored.

Usage: python3 scripts/export_my_certs.py [path/to/Grading\\ Batches.xlsx]
"""
import csv
import re
import sys
from pathlib import Path

import openpyxl

DEFAULT = Path.home() / "Library/Mobile Documents/com~apple~CloudDocs/Downloads/Grading Batches.xlsx"
OUT = Path(__file__).resolve().parent.parent / "data" / "my_certs.csv"


def tag_grade(text):
    """'10 GEM MINT' / '10 (988)' -> '10'; '10 PRISTINE' -> '10P'; '9 MINT' -> '9'."""
    t = str(text).strip().upper()
    m = re.match(r"(\d+(?:\.\d)?)", t)
    if not m:
        raise ValueError(f"unrecognized grade {text!r}")
    return m.group(1) + ("P" if "PRISTINE" in t else "")


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    rows = []
    for ws in wb:
        header = None
        for r in ws.iter_rows(values_only=True):
            if r and r[1] == "CARD NAME":
                header = [str(c).strip().upper() if c else "" for c in r]
                continue
            if not header:
                continue
            d = dict(zip(header, r))
            if str(d.get("BRAND") or "").strip().lower() != "life tcg":
                continue
            rows.append({
                "cert": str(d["CERT #"]).strip(), "grader": "TAG", "set": str(d["CARD SET"]).strip(),
                "num": str(d["CARD NO"]).strip(), "name": str(d["CARD NAME"]).strip(),
                "variant": (str(d["VARIATION"]).strip() if d.get("VARIATION") else ""),
                "grade": tag_grade(d["GRADE"]), "sheet": ws.title,
            })
    certs = [r["cert"] for r in rows]
    assert len(certs) == len(set(certs)), "duplicate cert numbers"
    OUT.parent.mkdir(exist_ok=True)
    with open(OUT, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["cert", "grader", "set", "num", "name", "variant", "grade"], extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} certs to {OUT}")


if __name__ == "__main__":
    main()
