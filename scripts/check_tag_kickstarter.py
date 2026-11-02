#!/usr/bin/env python3
"""Check that every TAG Mammals 1st Edition slab has been classified 1st Edition or Kickstarter.

TAG files Kickstarter copies under Mammals 1st Edition, so each slab is reviewed by its front scan
(Kickstarter: "(c)LIFE TCG 2022" plus a K stamp at the bottom center). Inputs:
  data/private/tag-mammals-certs-<date>.txt  card|grade|cert, from scripts/tag_certs.js (newest used)
  data/my_certs.csv                          Taclaco TAG certs (all count as 1st Edition, never submitted KS)
  data/tag_mammals_review.csv                cert,card,grade,edition(1st|KS),evidence,reviewed
  data/raw/tag-<date>.json                   newest TAG snapshot, for the cert-count check
Exit 1 if any non-Taclaco cert is unreviewed. Never prints Taclaco cert numbers.
"""
import csv
import glob
import json
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"


def newest(pattern):
    files = sorted(glob.glob(str(DATA / pattern)))
    if not files:
        sys.exit(f"no file matches data/{pattern}")
    return Path(files[-1])


def main():
    certs_file = newest("private/tag-mammals-certs-*.txt")
    certs = []
    for l in certs_file.read_text().splitlines():
        if l.strip() and not l.startswith("#"):
            card, grade, cert = l.strip().split("|")
            certs.append((cert, card, grade))
    mine = {r["cert"] for r in csv.DictReader(open(DATA / "my_certs.csv", newline="")) if r["grader"] == "TAG"}
    review = {r["cert"]: r for r in csv.DictReader(open(DATA / "tag_mammals_review.csv", newline=""))}
    snap = newest("raw/tag-*.json")
    pop = sum(r["grades"].get("TOTAL", 0) for r in json.load(open(snap)) if r["set"] == "Mammals 1st Edition")
    if pop != len(certs):
        print(f"!!! MISMATCH: {len(certs)} certs in {certs_file.name} but {snap.name} reports {pop} Mammals 1st Edition slabs. Cert list is stale, re-run scripts/tag_certs.js.")
    n_mine = sum(c in mine for c, _, _ in certs)
    rev = [review[c] for c, _, _ in certs if c in review and c not in mine]
    todo = [(c, card, g) for c, card, g in certs if c not in mine and c not in review]
    print(f"TAG Mammals 1st Edition certs: {len(certs)} ({certs_file.name}), pop {pop} ({snap.name})")
    print(f"  Taclaco (counted 1st Edition, no review): {n_mine}")
    print(f"  Reviewed 1st: {sum(r['edition'] == '1st' for r in rev)}")
    print(f"  Reviewed KS: {sum(r['edition'] == 'KS' for r in rev)}")
    print(f"  Unreviewed: {len(todo)}")
    for c, card, g in todo:
        print(f"    {card} {g} https://my.taggrading.com/card/{c}")
    sys.exit(1 if todo else 0)


if __name__ == "__main__":
    main()
