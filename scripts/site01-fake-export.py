#!/usr/bin/env python3
"""Build a Google-Form-shaped CSV from a frozen column manifest. A FIXTURE.

    python3 scripts/site01-fake-export.py --round w1 --rows 8 --out /tmp/w1.csv
    python3 scripts/site01-fake-export.py --round w1 --rows 8 --out /tmp/w1.csv \
        --with-email --extra-column "A question somebody added by hand"

Spec SITE-01 criterion 16 needs an export to round-trip. The Bali round-1 form has
not been run and SITE-00's end-to-end fill has not happened, so there is no real
export yet, and this manufactures one.

## What it does and does not prove, said plainly

It writes the manifest's own `title` strings as the header and the manifest's own
`choice` strings as rating values, which is exactly what Google writes. So it
exercises the mapping, the reserved-column skip by name, the five rating strings,
"I wasn't there", the audience label-to-key mapping, the unknown-column refusal
and the missing-column refusal.

It does NOT prove that Google's real header matches the manifest's titles. Only a
real export does that, and criterion 16 is re-run against the Bali round-1 sheet
when it exists. This file is deliberately separate from the importer so that the
two do not share a code path: it reads the contract, the importer reads the
contract, and a disagreement between them is visible. They do share the manifest,
which is the residual and is the point of a frozen contract.

## The rows are deterministic

No randomness, so a re-run produces the same CSV and a failing criterion can be
reproduced. Row n cycles through the scale so every one of the six choices appears
across eight rows, and the free-text answers carry the row number so a body that
lands against the wrong response is visible rather than plausible.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_evaluation_form import DEFAULT_VAULT, EVAL_SUBDIR  # noqa: E402

MANIFEST_NAME = {"w1": "Round-1-Columns.json", "w2": "Round-2-Columns.json"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--round", required=True, choices=["w1", "w2"])
    ap.add_argument("--rows", type=int, default=8)
    ap.add_argument("--out", required=True)
    ap.add_argument("--vault", default=str(DEFAULT_VAULT))
    ap.add_argument("--manifest")
    ap.add_argument("--with-email", action="store_true",
                    help="add the reserved 'Email Address' column, as switching on "
                         "response-email collection would")
    ap.add_argument("--emails", default="",
                    help="comma-separated addresses, cycled over the rows")
    ap.add_argument("--extra-column", action="append", default=[],
                    help="add a header the manifest does not know: the unknown-column "
                         "refusal's positive control")
    ap.add_argument("--drop-column", action="append", default=[],
                    help="omit a manifest column by title: the missing-column refusal")
    args = ap.parse_args()

    mpath = Path(args.manifest) if args.manifest else (
        Path(args.vault) / EVAL_SUBDIR / MANIFEST_NAME[args.round]
    )
    manifest = json.loads(mpath.read_text(encoding="utf-8"))
    scale = manifest["scale"]
    groups = [g["label"] for g in manifest["audience"]["groups"]]
    dropped = set(args.drop_column)

    cols = [c for c in manifest["columns"] if c["title"] not in dropped]

    header = ["Timestamp"]
    if args.with_email:
        header.append("Email Address")
    header += [c["title"] for c in cols]
    header += list(args.extra_column)

    emails = [e.strip() for e in args.emails.split(",") if e.strip()]

    rows = []
    for n in range(args.rows):
        row = [f"2026/08/28 1{n % 10}:0{n % 6}:00"]
        if args.with_email:
            row.append(emails[n % len(emails)] if emails else f"site01-rls-p{n}@example.org")
        for c in cols:
            if c["column_kind"] == "identity":
                row.append(f"Fixture Person {n}")
            elif c["column_kind"] == "audience":
                row.append(groups[n % len(groups)])
            elif c["scale_mapped"]:
                # Only offer the absence choice where the manifest says it exists.
                pool = scale if c["absence_option"] else [s for s in scale if s["attended"]]
                row.append(pool[(n + c["position"]) % len(pool)]["choice"])
            elif c["column_kind"] == "comment":
                # Not every item gets a comment; a sparse column is the real shape.
                row.append(f"row {n} comment on {c['item_key']}" if n % 3 == 0 else "")
            else:
                required = c["required"]
                row.append(f"row {n} answer to {c['question_key']}"
                           if required or n % 2 == 0 else "")
        row += [f"row {n} stray" for _ in args.extra_column]
        rows.append(row)

    out = Path(args.out)
    with out.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(header)
        w.writerows(rows)
    print(f"wrote {out}  {len(header)} column(s), {len(rows)} row(s), from {mpath.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
