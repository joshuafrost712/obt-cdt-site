#!/usr/bin/env python3
"""Criterion 12: every field of the moved sections round-trips, and an
unmappable one refuses.

    python3 scripts/site05_fields.py            # the round trip
    python3 scripts/site05_fields.py --refusals # the escape hatch, by mutation

## Why this compares against git history rather than against a list

The sections are gone from the working tree, which is the whole point of the
ordering rule. So the SOURCE side of the comparison is read from the commit
before the split (`git show <sha>:src/content/site-content.json`), and the
MOVED side is read from `member_block` on the live project. A criterion that
compared the document to a list of fields written in this file would only ever
check the fields somebody remembered, which is the class of defect D4's escape
hatch exists to catch.

## The three things it asserts

1.  Every block, at every depth, is present in `member_block` with every field
    intact. A full recursive diff, not a spot check: `number` (the section
    chip), `mediaId` (the photo band), `caption`, both `variant` values on
    `callout`, `numbered` on `bali.11.list`, `rows` on the three `glanceGrid`s,
    and the `cta` carrying `route` rather than `href` are all covered because
    everything is.
2.  `member_block.block_key`, the stored `Block.id` and the id the block
    carried in `site-content.json` are ONE string. That is SITE-03 D4's rule
    and the thing D4's explicit-id rule exists to protect.
3.  With `--refusals`: a field the format cannot express is REFUSED by name,
    never dropped, and so is a missing id in a document that declares them.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

MEMBER_ROUTE = "/members/psalms-bali-2026"
MOVED = ("bali.s4", "bali.s5")
# New by design and with no counterpart in the source: D7's revision-line
# carrier, and the provenance block that holds the gate token.
NEW_BY_DESIGN = ("bali.member.hero", "bali.member.provenance")

# The ONE field the move deliberately changes, named here with its reason so it
# is an exception a reader can see rather than a looser check. Decision 6, on
# Joshua's answer of 2026-08-27: the venue's name stays public and is NORMALISED
# to one form across `bali.hero.venue`, `cc.hero.venue` and this node, which
# carried a substring of the other two. Criterion 8 asserts the three agree; this
# is the same edit seen from the other side.
INTENDED_EDITS = {
    "bali.s5 > bali.03.venue > bali.03.venue.venue.value": (
        "University of the Nations base, Jimbaran",
        "University of the Nations base, Jimbaran, Bali",
    ),
}


def creds() -> tuple[str, str]:
    secret = Path.home() / ".claude/secrets/obt-cdt-supabase.env"
    env = {}
    for line in secret.read_text().split("\n"):
        if "=" in line and not line.strip().startswith("#"):
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip()
    return env["OBT_CDT_SUPABASE_PROJECT_REF"], env["OBT_CDT_SUPABASE_ACCESS_TOKEN"]


def sql(query: str):
    ref, token = creds()
    request = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{ref}/database/query",
        data=json.dumps({"query": query}).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "obt-cdt-site05-fields/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read().decode() or "[]")


def presplit_sections(sha: str) -> dict[str, dict]:
    """The two sections as they stood before the split, from git."""
    blob = subprocess.run(
        ["git", "show", f"{sha}:src/content/site-content.json"],
        cwd=REPO, capture_output=True, text=True, check=True,
    ).stdout
    content = json.loads(blob)
    ws = next(w for w in content["workshops"] if w["id"] == "psalms-bali-2026")
    found = {b["id"]: b for b in ws["blocks"] if b["id"] in MOVED}
    if len(found) != len(MOVED):
        raise SystemExit(
            f"REFUSED: {sha} does not carry both moved sections ({sorted(found)}). "
            "Pass the commit BEFORE the split with --sha."
        )
    return found


def find_split_commit() -> str:
    """The commit before the one that removed the sections."""
    out = subprocess.run(
        ["git", "log", "--format=%H", "-S", '"id": "bali.s4"', "--", "src/content/site-content.json"],
        cwd=REPO, capture_output=True, text=True, check=True,
    ).stdout.split()
    if not out:
        raise SystemExit("REFUSED: no commit in history touches bali.s4; pass --sha")
    # The newest such commit is the one that REMOVED it; its parent still has it.
    return f"{out[0]}^"


problems: list[str] = []
intended_seen: list[str] = []


def diff(source, moved, trail):
    if source is None:
        problems.append(f"{trail}: in member_block and not in the source")
        return
    if moved is None:
        problems.append(f"{trail}: in the source and NOT in member_block")
        return
    for key in sorted((set(source) | set(moved)) - {"items"}):
        if key not in source:
            problems.append(f"{trail}.{key}: ADDED by the move -> {moved[key]!r}")
        elif key not in moved:
            problems.append(f"{trail}.{key}: LOST by the move -> {source[key]!r}")
        elif source[key] != moved[key]:
            intended = INTENDED_EDITS.get(f"{trail}.{key}")
            if intended and (source[key], moved[key]) == intended:
                intended_seen.append(f"{trail}.{key}")
                continue
            problems.append(
                f"{trail}.{key}: CHANGED\n        was {source[key]!r}\n        now {moved[key]!r}"
            )
    si, mi = source.get("items", []), moved.get("items", [])
    if len(si) != len(mi):
        problems.append(f"{trail}.items: {len(si)} in the source, {len(mi)} in member_block")
    for i in range(min(len(si), len(mi))):
        diff(si[i], mi[i], f"{trail} > {si[i].get('id', i)}")


def round_trip(sha: str) -> int:
    source = presplit_sections(sha)
    rows = sql(
        "select block_key, ordinal, anchor, block from public.member_block "
        f"where route = '{MEMBER_ROUTE}' order by ordinal"
    )
    print(f"criterion 12, the field round trip")
    print(f"  source     : {sha}  ({len(source)} section(s))")
    print(f"  member_block: {len(rows)} row(s) on {MEMBER_ROUTE}")

    by_key = {}
    for row in rows:
        block = row["block"] if isinstance(row["block"], dict) else json.loads(row["block"])
        by_key[row["block_key"]] = (row, block)

    # Assertion 2, first, because it is the cheapest and the most load-bearing.
    key_failures = 0
    for key, (row, block) in by_key.items():
        if block.get("id") != key:
            key_failures += 1
            problems.append(f"{key}: block_key and the stored Block.id disagree ({block.get('id')!r})")
    for block_id in source:
        if block_id not in by_key:
            problems.append(f"{block_id}: no member_block row carries this id as its block_key")
    print(f"  {'ok  ' if not key_failures else 'FAIL'}  block_key IS the stored Block.id, for all "
          f"{len(by_key)} row(s)")

    # And the third string: the id the block carried in site-content.json.
    presplit_ids = set(source)
    matched = presplit_ids & set(by_key)
    print(f"  {'ok  ' if matched == presplit_ids else 'FAIL'}  and it is the same string the block "
          f"carried in site-content.json ({len(matched)}/{len(presplit_ids)})")

    # Assertion 1: the full recursive diff.
    for block_id, block in source.items():
        row_block = by_key.get(block_id, (None, None))[1]
        diff(block, row_block, block_id)

    new = [k for k in by_key if k not in source]
    for key in new:
        if key not in NEW_BY_DESIGN:
            problems.append(f"{key}: a block in member_block that the move did not carry")
    print(f"  note  {len(new)} block(s) new by design: {', '.join(new)}")

    # Depth, so a criterion that only walked the top level is visibly not this one.
    def count(blocks):
        return sum(1 + count(b.get("items", [])) for b in blocks)
    depth_total = count(list(source.values()))
    print(f"  note  {depth_total} block(s) compared at every depth, field for field")
    # The intended edits are PRINTED, never merely tolerated: an exception
    # nobody can see is indistinguishable from a check that stopped working.
    unused = [k for k in INTENDED_EDITS if k not in intended_seen]
    for key in intended_seen:
        print(f"  note  intended edit applied and accounted for: {key}")
    for key in unused:
        problems.append(f"{key}: declared an INTENDED edit that did not happen")

    if problems:
        print(f"\n  {len(problems)} DIFFERENCE(S):")
        for p in problems:
            print(f"    {p}")
        return 1
    print("\n  criterion 12: every field round-trips, and the three ids are one string.")
    return 0


def refusals() -> int:
    """The escape hatch, by mutation. Two plants, each watched refusing by name."""
    import seed_member_pages as seed

    vault = Path(os.environ.get("OBT_CDT_VAULT", Path.home() / "Documents/Josh & Katie Vault/Claude Can Access PARA"))
    doc = vault / "Projects/OBT/OBT-CDT Central Hub/Member Pages/Psalms-Handbook-Member.md"
    original = doc.read_text(encoding="utf-8")
    failures = 0
    print("criterion 12, the escape hatch: a field the format cannot express REFUSES")

    plants = [
        (
            "an unmappable FIELD on a named block",
            lambda t: t.replace(
                "id: bali.13.rooming\ntype: subsection",
                "id: bali.13.rooming\ntype: subsection\nroomNumber: 14b",
            ),
            ["roomNumber"],
        ),
        (
            "an unmappable table COLUMN",
            lambda t: t.replace(
                "| id | type | label | value |\n| --- | --- | --- | --- |",
                "| id | type | label | value | floor |\n| --- | --- | --- | --- | --- |",
                1,
            ),
            ["floor"],
        ),
        (
            "a MISSING id in a document that declares them (D4)",
            lambda t: t.replace("id: bali.13.space\n", ""),
            ["DECLARES block ids", "The teaching space"],
        ),
    ]
    try:
        for name, mutate, expect in plants:
            mutated = mutate(original)
            if mutated == original:
                failures += 1
                print(f"  FAIL  {name}: the plant did not apply, so nothing was tested")
                continue
            doc.write_text(mutated, encoding="utf-8")
            try:
                seed.load_doc(doc)
                failures += 1
                print(f"  FAIL  {name}: ACCEPTED, and a silently dropped field is a field that "
                      "never reaches the page")
            except seed.SeedError as exc:
                message = str(exc)
                named = [e for e in expect if e in message]
                ok = len(named) == len(expect)
                if not ok:
                    failures += 1
                print(f"  {'ok  ' if ok else 'FAIL'}  {name}: REFUSED, naming "
                      f"{', '.join(repr(e) for e in named) or 'nothing expected'}")
    finally:
        doc.write_text(original, encoding="utf-8")
        print("  restored the member document")

    # And the control: the unmutated document still parses, or the three
    # refusals above prove nothing about this document in particular.
    try:
        seed.load_doc(doc)
        print("  ok    control: the restored document parses cleanly")
    except seed.SeedError as exc:
        failures += 1
        print(f"  FAIL  control: the restored document does NOT parse: {exc}")

    print(f"\n  {failures} check(s) FAILED" if failures else "\n  criterion 12's escape hatch holds.")
    return 1 if failures else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sha", help="the commit BEFORE the split; found from history if omitted")
    ap.add_argument("--refusals", action="store_true", help="run the escape-hatch mutations instead")
    args = ap.parse_args()
    if args.refusals:
        return refusals()
    return round_trip(args.sha or find_split_commit())


if __name__ == "__main__":
    raise SystemExit(main())
