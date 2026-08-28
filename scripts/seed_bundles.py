#!/usr/bin/env python3
"""Seed the four intake occasions and their unit membership from the vault source.

Spec CDT-02 D1. Companion to seed_competency_registry.py and deliberately the same
shape: credentials from the environment and never from a command line, dry-run by
default, masked output, a digest over every source it read, and a refusal when the
source's shape has changed.

What makes this script worth writing rather than typing the SQL: `bundle_unit`
decides which of the 41 units each occasion rates, and `bundle_qualification`
decides **who may sit in judgment on it**. A hand-typed membership is 41 chances
to mis-key a unit and the qualification rows are worse, because a wrong row there
widens eligibility and no other control catches it. So the map is a reviewed vault
document, this script is the only writer, and the gate is set equality rather than
a count.

Why set equality and not a count: a map that covers 40 units and lists one twice
has 41 rows. That is the case this gate exists for, and a count passes it.

Usage
-----
    # look, change nothing (the default)
    python3 scripts/seed_bundles.py

    # write
    export SUPABASE_URL=https://<ref>.supabase.co
    export SUPABASE_SECRET_KEY=sb_secret_...        # service role; never logged
    python3 scripts/seed_bundles.py --apply

    # the map is not signed off yet and you know it
    python3 scripts/seed_bundles.py --apply --allow-unsigned-bundle-map

    # gate a scratch copy without touching the real map
    python3 scripts/seed_bundles.py --bundle-map /tmp/scratch.md

Exit codes: 0 fine, 1 a refusal you should read, 2 a usage error.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.cbc_matrix import MatrixError, load  # noqa: E402
from seed_competency_registry import Rest, mask  # noqa: E402

DEFAULT_VAULT = Path(
    os.environ.get(
        "OBT_CDT_VAULT",
        str(Path.home() / "Documents/Josh & Katie Vault/Claude Can Access PARA"),
    )
)
MATRIX_SUBDIR = "Projects/cbc-competency/cbc-matrix"
INTAKE_SUBDIR = "Projects/OBT/OBT Consultant Track/Intake Assessment/Instruments"
DOMAIN_MAP_NAME = "Domain-Map.md"
BUNDLE_MAP_NAME = "Bundle-Map.md"

# Insert order. A membership row references a bundle and a unit; a qualification
# row references a bundle.
# bundle_grant comes first: bundle_qualification's 'bundle'-scoped rows are
# validated against it by qualification_scope_guard, so its rows must land before
# theirs.
TABLE_ORDER = [
    "assessment_bundle",
    "bundle_grant",
    "bundle_unit",
    "bundle_qualification",
]

# The four occasions and their primary counts, from the approved plan. These are
# not derived from the map: they are what the map is checked against, so a map
# that quietly moves a unit between occasions is refused rather than seeded.
EXPECTED_BUNDLES = ["I-1", "I-2", "I-3", "I-4"]
EXPECTED_PRIMARIES = {"I-1": 16, "I-2": 6, "I-3": 10, "I-4": 9}

# Bundle-scoped grant names, and their labels. A closed set, because
# `scope_kind = 'bundle'` is the one scope whose key is not a foreign key into the
# registry, so a typo there would otherwise seed a grant nobody holds and refuse
# every assignment.
#
# Since 2026-08-21 this set is also seeded into `public.bundle_grant`, so the
# database validates the same vocabulary this script does rather than trusting it.
# Joshua settled the reading that day: a bundle-scoped grant names a CREDENTIAL,
# not an occasion. See the bundle_grant comment in
# supabase/migrations/20260908120000_assessment_spine.sql.
BUNDLE_GRANTS = {
    "obt-cdt-facilitator": (
        "OBT-CDT facilitator status",
        "The plan's grant for I-4, bundle-scoped on purpose so soft-skill "
        "eligibility does not leak into the hard-skill occasions.",
    ),
}
BUNDLE_SCOPE_KEYS = set(BUNDLE_GRANTS)

# The plan's own constraint on I-4: its units straddle these four macro domains.
I4_DOMAINS = {"M1", "M2", "M4", "M6"}

BOOL_WORDS = {"true": True, "false": False}


class BundleMapError(Exception):
    """A refusal to read. Always names the file and the row."""


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _flag(value: str, path: str, what: str) -> bool:
    if value.lower() not in BOOL_WORDS:
        raise BundleMapError(f"{path}: {what} must be true or false, got {value!r}")
    return BOOL_WORDS[value.lower()]


def _int(value: str, path: str, what: str) -> int:
    if not re.fullmatch(r"-?\d+", value):
        raise BundleMapError(f"{path}: {what} must be an integer, got {value!r}")
    return int(value)


def parse_bundle_map(text: str, path: str) -> tuple[list[dict], list[dict], list[dict], bool]:
    """The four bundles, the membership rows and the qualifying grants.

    Rows are only read inside their own `##` section, so the prose tables
    elsewhere in the document cannot be mistaken for data. A `###` heading does
    not close a section, because the membership tables sit one per occasion.
    """
    signed = bool(re.search(r"^signed_off:\s*true\s*$", text, re.M))

    bundles: list[dict] = []
    members: list[dict] = []
    grants: list[dict] = []
    section = None

    for n, line in enumerate(text.split("\n"), start=1):
        if line.startswith("## Bundles"):
            section = "bundles"
            continue
        if line.startswith("## Unit membership"):
            section = "members"
            continue
        if line.startswith("## Qualifying grants"):
            section = "grants"
            continue
        if line.startswith("## "):
            section = None
            continue
        s = line.strip()
        if section is None or not s.startswith("|"):
            continue
        cells = _cells(s)
        where = f"{path}:{n}"

        if section == "bundles" and re.fullmatch(r"I-\d+", cells[0]):
            if len(cells) != 8:
                raise BundleMapError(
                    f"{where}: a bundle row needs 8 columns, found {len(cells)}"
                )
            bundles.append(
                {
                    "bundle_key": cells[0],
                    "name": cells[1],
                    "format": cells[2],
                    "minutes": _int(cells[3], where, "minutes"),
                    "prep_minutes": _int(cells[4], where, "prep_minutes"),
                    "writeup_minutes": _int(cells[5], where, "writeup_minutes"),
                    "ordinal": _int(cells[6], where, "ordinal"),
                    "active": _flag(cells[7], where, "active"),
                }
            )
        elif section == "members" and re.fullmatch(r"U\d{2}", cells[0]):
            if len(cells) != 5:
                raise BundleMapError(
                    f"{where}: a membership row needs 5 columns, found {len(cells)}"
                )
            members.append(
                {
                    "unit_key": cells[0],
                    "category_key": cells[1],
                    "bundle_key": cells[2],
                    "is_primary": _flag(cells[3], where, "is_primary"),
                    "line": n,
                }
            )
        elif section == "grants" and re.fullmatch(r"I-\d+", cells[0]):
            if len(cells) != 4:
                raise BundleMapError(
                    f"{where}: a grant row needs 4 columns, found {len(cells)}"
                )
            grants.append(
                {
                    "bundle_key": cells[0],
                    "scope_kind": cells[1],
                    "scope_key": cells[2],
                    "line": n,
                }
            )

    if not bundles:
        raise BundleMapError(f"{path}: no bundle rows found under `## Bundles`")
    if not members:
        raise BundleMapError(f"{path}: no membership rows found under `## Unit membership`")
    if not grants:
        raise BundleMapError(f"{path}: no grant rows found under `## Qualifying grants`")
    return bundles, members, grants, signed


def gate(bundles, members, grants, reg, domain_keys, path) -> dict:
    """Every refusal this script can make, each naming what failed and where.

    Ordered cheapest first, so a malformed row is reported before a set
    comparison whose output would be dominated by the same mistake.
    """
    registry_units = {u.unit_key for u in reg.units}
    category_keys = {c["category_key"] for c in reg.categories}
    unit_category = {u.unit_key: u.category_key for u in reg.units}
    unit_domain = {}
    primary_domain = {
        l["category_key"]: l["domain_key"] for l in reg.links if l["is_primary"]
    }
    for u in reg.units:
        unit_domain[u.unit_key] = primary_domain.get(u.category_key)

    # --- the bundles themselves -------------------------------------------
    keys = [b["bundle_key"] for b in bundles]
    if sorted(keys) != sorted(EXPECTED_BUNDLES):
        raise BundleMapError(
            f"{path}: expected bundles {EXPECTED_BUNDLES}, found {sorted(keys)}. "
            "The four occasions are fixed by the approved plan; adding or removing "
            "one is a plan change, not a map edit."
        )
    if len(set(keys)) != len(keys):
        raise BundleMapError(f"{path}: a bundle_key appears twice: {sorted(keys)}")

    # --- membership rows point at things that exist ------------------------
    for m in members:
        if m["unit_key"] not in registry_units:
            raise BundleMapError(
                f"{path}:{m['line']}: unit {m['unit_key']} is not in the registry. "
                "Unit keys are generated by the registry seed and never typed."
            )
        if m["bundle_key"] not in set(keys):
            raise BundleMapError(
                f"{path}:{m['line']}: unit {m['unit_key']} is assigned to bundle "
                f"{m['bundle_key']}, which is not one of {sorted(keys)}"
            )
        real = unit_category[m["unit_key"]]
        if m["category_key"] and m["category_key"] != real:
            raise BundleMapError(
                f"{path}:{m['line']}: {m['unit_key']} is category {real} in the "
                f"registry, and this row says {m['category_key']}. The registry "
                "wins; fix the row."
            )

    dupes = sorted(
        {
            (m["bundle_key"], m["unit_key"])
            for m in members
            if sum(
                1
                for o in members
                if (o["bundle_key"], o["unit_key"]) == (m["bundle_key"], m["unit_key"])
            )
            > 1
        }
    )
    if dupes:
        raise BundleMapError(
            f"{path}: these (bundle, unit) pairs appear more than once, and the "
            f"table's primary key would refuse them: {dupes}"
        )

    # --- set equality over primaries, in both directions -------------------
    primaries = [m for m in members if m["is_primary"]]
    primary_of: dict[str, list[str]] = {}
    for m in primaries:
        primary_of.setdefault(m["unit_key"], []).append(m["bundle_key"])

    # A secondary whose unit has no primary is checked FIRST, and the ordering is
    # the whole reason it works. Run after set equality it can never fire: once
    # the primary set equals the registry's 41 and every row's unit is a registry
    # unit, no secondary can lack a primary, so the check would be a gate that
    # always passes. Run before it, the more specific message wins for the shape
    # it describes and set equality still catches everything else.
    orphan_secondaries = sorted(
        {m["unit_key"] for m in members if not m["is_primary"]} - set(primary_of)
    )
    if orphan_secondaries:
        raise BundleMapError(
            f"{path}: these units are listed as a secondary but have no primary "
            f"occasion anywhere, so nothing would ever rate them first: "
            f"{orphan_secondaries}"
        )

    missing = sorted(registry_units - set(primary_of))
    doubled = sorted(k for k, v in primary_of.items() if len(v) > 1)
    stray = sorted(set(primary_of) - registry_units)
    if missing or doubled or stray:
        lines = [f"{path}: the primary set is not the registry's 41 units."]
        if missing:
            lines.append(f"  no primary bundle for: {missing}")
        if doubled:
            lines.append(
                "  primary in more than one bundle: "
                + ", ".join(f"{k} in {primary_of[k]}" for k in doubled)
            )
        if stray:
            lines.append(f"  primary for a unit not in the registry: {stray}")
        raise BundleMapError("\n".join(lines))

    # --- per-bundle primary counts, against the plan ------------------------
    counted = {k: sum(1 for m in primaries if m["bundle_key"] == k) for k in keys}
    if counted != EXPECTED_PRIMARIES:
        raise BundleMapError(
            f"{path}: primaries per bundle are {counted}, and the approved plan "
            f"fixes them at {EXPECTED_PRIMARIES}. The plan's counts sum to 41 and "
            "are quoted in the map's own header, so a disagreement here is either "
            "a moved unit or a plan change."
        )

    # --- the plan's constraint on I-4 ---------------------------------------
    i4 = {unit_domain[m["unit_key"]] for m in primaries if m["bundle_key"] == "I-4"}
    if not I4_DOMAINS <= i4:
        raise BundleMapError(
            f"{path}: I-4's primaries touch macro domains {sorted(d for d in i4 if d)}, "
            f"and the plan says its nine units straddle {sorted(I4_DOMAINS)}. "
            "Missing: " + str(sorted(I4_DOMAINS - i4))
        )

    # --- qualifying grants ---------------------------------------------------
    for g in grants:
        if g["bundle_key"] not in set(keys):
            raise BundleMapError(
                f"{path}:{g['line']}: grant names bundle {g['bundle_key']}, which "
                f"is not one of {sorted(keys)}"
            )
        kind, key = g["scope_kind"], g["scope_key"]
        if kind == "domain" and key not in domain_keys:
            raise BundleMapError(
                f"{path}:{g['line']}: {key} is not a domain in {DOMAIN_MAP_NAME} "
                f"({sorted(domain_keys)})"
            )
        if kind == "category" and key not in category_keys:
            raise BundleMapError(
                f"{path}:{g['line']}: {key} is not a category_key in the registry"
            )
        if kind == "bundle" and key not in BUNDLE_SCOPE_KEYS:
            raise BundleMapError(
                f"{path}:{g['line']}: {key} is not a known bundle-scoped grant "
                f"({sorted(BUNDLE_SCOPE_KEYS)}). A grant nobody holds refuses every "
                "assignment, so this is a refusal rather than a warning."
            )
        if kind not in ("domain", "category", "bundle"):
            raise BundleMapError(
                f"{path}:{g['line']}: scope_kind must be domain, category or "
                f"bundle, got {kind!r}"
            )

    ungranted = sorted(set(keys) - {g["bundle_key"] for g in grants})
    if ungranted:
        raise BundleMapError(
            f"{path}: these bundles have no qualifying grant at all, so no "
            f"consultant could ever be assigned to them: {ungranted}"
        )

    dupe_grants = sorted(
        {
            (g["bundle_key"], g["scope_kind"], g["scope_key"])
            for g in grants
            if sum(
                1
                for o in grants
                if (o["bundle_key"], o["scope_kind"], o["scope_key"])
                == (g["bundle_key"], g["scope_kind"], g["scope_key"])
            )
            > 1
        }
    )
    if dupe_grants:
        raise BundleMapError(f"{path}: duplicate grant rows: {dupe_grants}")

    return {
        "primaries": len(primaries),
        "secondaries": len(members) - len(primaries),
        "per_bundle": counted,
        "grants": len(grants),
        "i4_domains": sorted(d for d in i4 if d),
    }


def rows_for(bundles, members, grants) -> dict[str, list[dict]]:
    return {
        "assessment_bundle": [
            {k: b[k] for k in b if k != "line"} for b in bundles
        ],
        # Not from the map: the vocabulary is a closed set in reviewed code, and
        # the map is checked against it. Seeded so the database's scope guard
        # validates the same set rather than trusting this script.
        "bundle_grant": [
            {"grant_key": k, "label": v[0], "note": v[1]}
            for k, v in sorted(BUNDLE_GRANTS.items())
        ],
        "bundle_unit": [
            {
                "bundle_key": m["bundle_key"],
                "unit_key": m["unit_key"],
                "is_primary": m["is_primary"],
            }
            for m in members
        ],
        "bundle_qualification": [
            {
                "bundle_key": g["bundle_key"],
                "scope_kind": g["scope_kind"],
                "scope_key": g["scope_key"],
            }
            for g in grants
        ],
    }


CONFLICT = {
    "assessment_bundle": "bundle_key",
    "bundle_grant": "grant_key",
    "bundle_unit": "bundle_key,unit_key",
    "bundle_qualification": "bundle_key,scope_kind,scope_key",
}


def _sql_literal(v) -> str:
    """A Postgres literal for the handful of types these row dicts hold."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def _as_sql(rows: dict[str, list[dict]]) -> str:
    """The rows as INSERT statements, in TABLE_ORDER so foreign keys resolve."""
    out = [
        "-- Generated by scripts/seed_bundles.py --emit-sql. Do not edit.",
        "-- These rows come from an UNSIGNED bundle map and are for use inside a",
        "-- transaction that will be rolled back. Never commit them.",
        "",
    ]
    for t in TABLE_ORDER:
        if not rows[t]:
            continue
        cols = list(rows[t][0].keys())
        out.append(f"-- {t}: {len(rows[t])} rows")
        out.append(f"insert into public.{t} ({', '.join(cols)}) values")
        values = [
            "  (" + ", ".join(_sql_literal(r[c]) for c in cols) + ")" for r in rows[t]
        ]
        out.append(",\n".join(values) + ";")
        out.append("")
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="write; default is a dry run")
    ap.add_argument(
        "--emit-sql",
        type=Path,
        help="write the rows as SQL to this path instead of a database, for a "
        "test harness that seeds them inside a rolled-back transaction",
    )
    ap.add_argument("--vault", type=Path, default=DEFAULT_VAULT)
    ap.add_argument(
        "--bundle-map",
        type=Path,
        default=None,
        help="override the map's path, for gating a scratch copy",
    )
    ap.add_argument(
        "--allow-unsigned-bundle-map",
        action="store_true",
        help="seed from a map the instrument track has not signed off",
    )
    args = ap.parse_args()

    matrix_dir = args.vault / MATRIX_SUBDIR
    domain_map = args.vault / INTAKE_SUBDIR / DOMAIN_MAP_NAME
    bundle_map = args.bundle_map or (args.vault / INTAKE_SUBDIR / BUNDLE_MAP_NAME)

    print(f"matrix     {matrix_dir}")
    print(f"domain map {domain_map}")
    print(f"bundle map {bundle_map}")

    if not bundle_map.is_file():
        print(
            f"\nrefused: {bundle_map} does not exist.\n"
            "  The bundle map is an instrument-track document, reviewed and due\n"
            "  2026-08-26. Nothing is seeded without it and no placeholder bundle is\n"
            "  invented, because a placeholder bundle would be assignable.",
            file=sys.stderr,
        )
        return 1

    try:
        reg = load(matrix_dir, domain_map)
    except MatrixError as e:
        print(f"\nrefused by the registry loader: {e}", file=sys.stderr)
        return 1

    text = bundle_map.read_text(encoding="utf-8")
    try:
        bundles, members, grants, signed = parse_bundle_map(text, str(bundle_map))
        domain_keys = {d["domain_key"] for d in reg.domains}
        counts = gate(bundles, members, grants, reg, domain_keys, str(bundle_map))
    except BundleMapError as e:
        print(f"\nrefused: {e}", file=sys.stderr)
        return 1

    digest = hashlib.sha256()
    digest.update(reg.source_digest.encode())
    digest.update(BUNDLE_MAP_NAME.encode())
    digest.update(text.encode())
    source_digest = digest.hexdigest()

    rows = rows_for(bundles, members, grants)
    total = sum(len(v) for v in rows.values())

    print("\ncounts, re-measured from the sources in this run")
    print(f"  bundles                {len(bundles):>4}   expected {len(EXPECTED_BUNDLES)}")
    print(f"  primary memberships    {counts['primaries']:>4}   expected {len(reg.units)}")
    print(f"  secondary memberships  {counts['secondaries']:>4}   (no expectation; each is a judgment)")
    print(f"  qualifying grants      {counts['grants']:>4}")
    print(f"  primaries per bundle : {counts['per_bundle']}")
    print(f"  I-4 macro domains    : {counts['i4_domains']}   (plan requires M1, M2, M4, M6)")
    print(f"  registry units       : {len(reg.units)}  registry digest {reg.source_digest[:16]}…")
    print(f"  source digest: {source_digest[:16]}…")
    print(
        f"  {BUNDLE_MAP_NAME} signed off: "
        + ("YES" if signed else "NO (see --allow-unsigned-bundle-map)")
    )
    print(f"  {DOMAIN_MAP_NAME} signed off: " + ("YES" if reg.domain_map_signed_off else "NO"))

    print(f"\n{total} rows across {len(rows)} tables")
    for t in TABLE_ORDER:
        print(f"  {t:<24}{len(rows[t]):>5}")

    if args.emit_sql:
        # Emit the SAME rows this script would upsert, as SQL on stdout, so a test
        # harness can seed them inside a transaction it will roll back. This exists
        # because CDT-02's criteria 3 and 10 must run against the REAL I-1 to I-4
        # rows ("no invented bundles"), while the map is not signed off and must not
        # be written durably. The alternative was a second parser in the harness,
        # which is the 41-chances-to-mis-key failure this script was written to
        # prevent. It writes nothing itself and needs no credentials.
        #
        # It deliberately runs AFTER the gate above, so a map that fails the gate
        # emits no SQL.
        args.emit_sql.write_text(_as_sql(rows), encoding="utf-8")
        print(f"\nemitted {total} rows as SQL to {args.emit_sql}")
        print("nothing written to any database, and no credentials were read.")
        return 0

    if not args.apply:
        print(
            "\ndry run, nothing written. Re-run with --apply once SUPABASE_URL and\n"
            "SUPABASE_SECRET_KEY are set. The counts above are the whole gate; if it\n"
            "printed them, the map is in the shape this spine expects."
        )
        return 0

    if not signed and not args.allow_unsigned_bundle_map:
        print(
            f"\nrefused: {BUNDLE_MAP_NAME} is not signed off.\n"
            "  These rows decide who may assess whom, so they are seeded from a\n"
            "  reviewed document or not at all. Pass --allow-unsigned-bundle-map to\n"
            "  seed a draft deliberately.",
            file=sys.stderr,
        )
        return 1

    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SECRET_KEY", "")
    if not url or not key:
        print(
            "\nrefused: --apply needs SUPABASE_URL and SUPABASE_SECRET_KEY in the\n"
            "  environment. They are never accepted on the command line, because a\n"
            "  command line ends up in shell history.\n"
            f"  SUPABASE_URL={url or '(unset)'}  SUPABASE_SECRET_KEY={mask(key)}",
            file=sys.stderr,
        )
        return 2

    rest = Rest(url, key)
    for t in TABLE_ORDER:
        rest.upsert(t, rows[t], CONFLICT[t])
        print(f"  {t:<24}{len(rows[t]):>5} upserted")

    print(f"\nwrote {total} rows. source digest {source_digest[:16]}…")
    print(json.dumps({"source_digest": source_digest, "counts": counts}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
