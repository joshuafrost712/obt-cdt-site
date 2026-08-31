#!/usr/bin/env python3
"""Seed the evaluation instrument into the portal database, from the contracts.

    python3 scripts/seed_evaluation_instrument.py                      # dry run
    python3 scripts/seed_evaluation_instrument.py --print              # + every row
    python3 scripts/seed_evaluation_instrument.py --emit-sql out.sql   # no credentials
    python3 scripts/seed_evaluation_instrument.py --apply              # durable write

Spec SITE-01 D5. The companion of `build_evaluation_form.py`: that script turns
`Session-Map.md` and `Question-Set.md` into a Google Form, this one turns the same
two documents into `evaluation_item`, `evaluation_question` and
`evaluation_respondent_group`. One pair of contracts, two consumers.

## It imports the generator's parsers rather than writing its own

`parse_session_map`, `derive_keys`, `parse_question_set` and `compute_digest` all
come from `build_evaluation_form.py`. A second parser over the same two documents
is the 41-chances-to-mis-key failure `seed_bundles.py` was written to prevent, and
here it would be worse than a mis-key: the form and the portal would disagree
about what the workshop taught, and the disagreement would surface as an import
that silently dropped columns.

## Re-running is the correction path

Every write is an upsert and the digest is RECORDED, never used to skip. A seed
that short-circuits on an unchanged digest reports "no change" for an edit that
did not land, which is the caching failure the corpus report pipeline learned the
expensive way. Change a title in the map, re-run, and the change reaches the
database.

## The four refusals

Missing file, malformed table, duplicate key, and an unsigned `Session-Map.md`
without `--allow-unsigned-session-map`. The first three come free from the
generator's parsers, which is a second reason to import them. The fourth is
SITE-00 D1's gate and it exists because a participant rating a session under a
title transcribed from a plan rather than from what was delivered is being asked
the wrong question.

## What the round window is, and what it is not

`opens_at` and `closes_at` are NOT in either contract document, so this script
does not pretend they are. They default from the workshop's own `events` row and
are printed as defaults, and `--opens-at` / `--closes-at` override them.

A seeded round is always `draft`. Opening a round is a decision someone makes on
a day, not a side effect of seeding an instrument, and a seed that opened one
would start collecting responses the moment it ran.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_evaluation_form import (  # noqa: E402
    ContractError,
    DEFAULT_VAULT,
    EVAL_SUBDIR,
    QUESTION_SET_NAME,
    ROUNDS,
    SESSION_MAP_NAME,
    compute_digest,
    derive_keys,
    parse_question_set,
    parse_session_map,
)

DEFAULT_WORKSHOP = "psalms-bali-2026"

# The window's default, in days from the workshop's own start_date. Stated as a
# constant with its reasoning rather than buried in an expression: round 1 is at
# the end of week 1, round 2 at the end of week 2, and both stay open a fortnight
# so somebody travelling home can still file.
WINDOW_DAYS = {"w1": (4, 18), "w2": (11, 25)}

ROUND_TITLE = {"w1": "Week 1", "w2": "End of course"}


class SeedError(Exception):
    pass


# --------------------------------------------------------------------------- #
# SQL
# --------------------------------------------------------------------------- #

def lit(value) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def build_sql(plan: dict) -> str:
    """Every statement this seed would run, in order, as plain SQL.

    Emitted rather than executed piecemeal so `--emit-sql` and `--apply` are the
    same rows by construction. CDT-04 established the pattern: a harness that
    needs the instrument present while the contracts are unsigned asks the seed
    for its SQL, posts it as postgres inside its own transaction, and rolls back.
    """
    out: list[str] = [
        "-- scripts/seed_evaluation_instrument.py, spec SITE-01 D5. Generated; do not hand-edit.",
        f"-- workshop {plan['workshop']}  rounds {', '.join(plan['rounds'])}",
        f"-- source_digest {plan['digest']}",
        f"-- Session-Map.md {plan['per_file'][SESSION_MAP_NAME]}"
        f"  Question-Set.md {plan['per_file'][QUESTION_SET_NAME]}",
        f"-- signed_off {plan['signed_off']}"
        + ("  (OVERRIDDEN with --allow-unsigned-session-map)" if not plan["signed_off"] else ""),
        "",
    ]

    # ---- the audience groups (R1). Round-independent: they describe who is
    # answering, not what is being asked.
    out.append("-- R1. The audience groups, from Question-Set.md's own table.")
    for g in plan["groups"]:
        out.append(
            "insert into public.evaluation_respondent_group (group_key, label, ordinal) values ("
            f"{lit(g['group_key'])}, {lit(g['label'])}, {g['ordinal']})\n"
            "on conflict (group_key) do update set "
            "label = excluded.label, ordinal = excluded.ordinal, updated_at = now();"
        )
    keys = ", ".join(lit(g["group_key"]) for g in plan["groups"])
    out += [
        "",
        "-- A group dropped from the contract has to disappear. The foreign key from",
        "-- evaluation_response refuses the delete if anyone answered as that group,",
        "-- which is the correct outcome: you cannot retire a group people used.",
        f"delete from public.evaluation_respondent_group where group_key not in ({keys});",
        "",
    ]

    for rnd in plan["rounds"]:
        r = plan["by_round"][rnd]
        out += [
            f"-- ======================================================== round {rnd}",
            "insert into public.workshop_evaluation_round",
            "  (round_key, workshop_key, display_name, opens_at, closes_at, state) values (",
            f"  {lit(r['round_key'])}, {lit(plan['workshop'])}, {lit(r['display_name'])},",
            f"  {lit(r['opens_at'])}::timestamptz, {lit(r['closes_at'])}::timestamptz, 'draft')",
            "on conflict (round_key) do update set",
            "  workshop_key = excluded.workshop_key, display_name = excluded.display_name,",
            "  opens_at = excluded.opens_at, closes_at = excluded.closes_at;",
            "-- state is NOT in the update list. Re-seeding an open round must not",
            "-- shut it, and re-seeding a closed one must not reopen it.",
            "",
            "-- One salt per round, generated by the column default and never by this",
            "-- script: a secret that passed through a generated .sql file has been",
            "-- written to disk and possibly to a repo.",
            f"insert into public.evaluation_salt (round_key) values ({lit(r['round_key'])})",
            "on conflict (round_key) do nothing;",
            "",
        ]

        for it in r["items"]:
            out.append(
                "insert into public.evaluation_item\n"
                "  (round_key, item_key, day, part, kind, title, facilitator, ordinal, active, note) values (\n"
                f"  {lit(r['round_key'])}, {lit(it['item_key'])}, {it['day']}, {lit(it['part'])},\n"
                f"  {lit(it['kind'])}, {lit(it['title'])}, {lit(it['facilitator'])}, {it['ordinal']},\n"
                f"  {lit(it['active'])}, {lit(it['note'])})\n"
                "on conflict (round_key, item_key) do update set\n"
                "  day = excluded.day, part = excluded.part, kind = excluded.kind,\n"
                "  title = excluded.title, facilitator = excluded.facilitator,\n"
                "  ordinal = excluded.ordinal, active = excluded.active,\n"
                "  note = excluded.note, updated_at = now();"
            )

        for qn in r["questions"]:
            out.append(
                "insert into public.evaluation_question\n"
                "  (round_key, question_key, ordinal, kind, required, prompt, active) values (\n"
                f"  {lit(r['round_key'])}, {lit(qn['question_key'])}, {qn['ordinal']},\n"
                f"  {lit(qn['kind'])}, {lit(qn['required'])}, {lit(qn['prompt'])}, true)\n"
                "on conflict (round_key, question_key) do update set\n"
                "  ordinal = excluded.ordinal, kind = excluded.kind,\n"
                "  required = excluded.required, prompt = excluded.prompt,\n"
                "  active = excluded.active, updated_at = now();"
            )

        # A row removed from the contract has to disappear, not linger. But an
        # item somebody has already rated cannot be removed, and an opaque
        # foreign-key error names a constraint rather than the problem. So the
        # refusal is explicit and names the rows and their rating counts.
        item_keys = ", ".join(lit(i["item_key"]) for i in r["items"]) or "null"
        q_keys = ", ".join(lit(q["question_key"]) for q in r["questions"]) or "null"
        out += [
            "",
            "do $$",
            "declare _stuck text;",
            "begin",
            "  select string_agg(x.item_key || ' (' || x.n || ' ratings)', ', ') into _stuck",
            "  from (",
            "    select i.item_key, count(r.*) as n",
            "    from public.evaluation_item i",
            "    join public.evaluation_item_rating r",
            "      on r.round_key = i.round_key and r.item_key = i.item_key",
            f"    where i.round_key = {lit(r['round_key'])}",
            f"      and i.item_key not in ({item_keys})",
            "    group by i.item_key",
            "  ) x;",
            "  if _stuck is not null then",
            "    raise exception 'These items are gone from Session-Map.md but people have "
            "already rated them, so removing them would destroy answers: %. Put the row back, "
            "or delete the ratings deliberately.', _stuck;",
            "  end if;",
            "end $$;",
            "",
            f"delete from public.evaluation_item where round_key = {lit(r['round_key'])}",
            f"  and item_key not in ({item_keys});",
            f"delete from public.evaluation_question where round_key = {lit(r['round_key'])}",
            f"  and question_key not in ({q_keys});",
            "",
        ]

    return "\n".join(out) + "\n"


# --------------------------------------------------------------------------- #
# The plan
# --------------------------------------------------------------------------- #

def build_plan(args) -> dict:
    vault = Path(args.vault)
    folder = vault / EVAL_SUBDIR
    smap = folder / SESSION_MAP_NAME
    qset = folder / QUESTION_SET_NAME
    for path in (smap, qset):
        if not path.exists():
            raise SeedError(
                f"missing contract document: {path}\n"
                "  Both are required. The instrument is not allowed to come from "
                "one document and a default."
            )

    sources = {
        SESSION_MAP_NAME: smap.read_text(encoding="utf-8"),
        QUESTION_SET_NAME: qset.read_text(encoding="utf-8"),
    }
    rows, meta = parse_session_map(sources[SESSION_MAP_NAME], str(smap))
    derive_keys(rows, str(smap))
    qs = parse_question_set(sources[QUESTION_SET_NAME], str(qset))
    digest, per_file = compute_digest(sources)

    if not meta["signed_off"] and not args.allow_unsigned_session_map:
        raise SeedError(
            f"{smap} is not signed off, so nothing was written.\n"
            "  The sign-off exists because a participant rating a session under a\n"
            "  title transcribed from a plan rather than from what was delivered is\n"
            "  being asked the wrong question.\n"
            "  Re-run with --allow-unsigned-session-map to seed anyway; the override\n"
            "  is recorded in the emitted SQL header and printed here."
        )

    rounds = list(ROUNDS) if args.round == "all" else [args.round]

    start = args.start_date
    if start is None:
        raise SeedError("internal: start_date was not resolved")

    by_round = {}
    for rnd in rounds:
        opens_offset, closes_offset = WINDOW_DAYS[rnd]
        opens = args.opens_at.get(rnd) or (
            (start + dt.timedelta(days=opens_offset)).isoformat() + "T17:00:00+08:00"
        )
        closes = args.closes_at.get(rnd) or (
            (start + dt.timedelta(days=closes_offset)).isoformat() + "T23:59:59+08:00"
        )
        items = sorted(
            (r for r in rows if r["round"] == rnd),
            key=lambda r: (r["day"], r["ordinal"], r["item_key"]),
        )
        questions = sorted(
            (q for q in qs["questions"] if q["round"] in (rnd, "both")),
            key=lambda q: (q["ordinal"], q["question_key"]),
        )
        by_round[rnd] = {
            "round_key": f"{args.workshop}:{rnd}",
            "display_name": ROUND_TITLE[rnd],
            "opens_at": opens,
            "closes_at": closes,
            "opens_defaulted": rnd not in args.opens_at,
            "closes_defaulted": rnd not in args.closes_at,
            "items": items,
            "questions": questions,
        }

    return {
        "workshop": args.workshop,
        "rounds": rounds,
        "by_round": by_round,
        "groups": [
            {"group_key": g["group_key"], "label": g["label"], "ordinal": i}
            for i, g in enumerate(qs["audience"]["groups"], start=1)
        ],
        "digest": digest,
        "per_file": per_file,
        "signed_off": meta["signed_off"],
        "shapes": meta["shapes"],
    }


def describe(plan: dict, verbose: bool) -> None:
    """Print what would be written, before writing it."""
    print(f"workshop      {plan['workshop']}")
    print(f"source_digest {plan['digest']}")
    print(f"signed_off    {plan['signed_off']}"
          + ("   <- OVERRIDDEN" if not plan["signed_off"] else ""))
    print(f"groups        {len(plan['groups'])}: "
          + ", ".join(g["group_key"] for g in plan["groups"]))
    for rnd in plan["rounds"]:
        r = plan["by_round"][rnd]
        active = sum(1 for i in r["items"] if i["active"])
        print(f"\nround {r['round_key']}   form_shape {plan['shapes'][rnd]}")
        print(f"  window      {r['opens_at']}  ->  {r['closes_at']}"
              + ("   (both defaulted from the events row)"
                 if r["opens_defaulted"] and r["closes_defaulted"] else ""))
        print(f"  items       {len(r['items'])} ({active} active, "
              f"{len(r['items']) - active} inactive)")
        print(f"  questions   {len(r['questions'])}: "
              + ", ".join(q["question_key"] for q in r["questions"]))
        if plan["shapes"][rnd] == "aggregate":
            print("  note        this round's GOOGLE FORM asks no item; the portal asks")
            print("              all of them. Session-Map.md keeps them active on purpose.")
        if verbose:
            for i in r["items"]:
                flag = " " if i["active"] else "-"
                print(f"    {flag} {i['item_key']:<10} {i['kind']:<11} {i['title'][:52]}")


# --------------------------------------------------------------------------- #
# The gate
# --------------------------------------------------------------------------- #

def read_back(plan: dict) -> dict:
    """What the database actually holds now, for the set-equality gate."""
    rounds = ", ".join(lit(plan["by_round"][r]["round_key"]) for r in plan["rounds"])
    rows = post_sql(
        f"select 'item' as t, round_key as a, item_key as b from public.evaluation_item "
        f"where round_key in ({rounds}) "
        f"union all select 'question', round_key, question_key from public.evaluation_question "
        f"where round_key in ({rounds}) "
        f"union all select 'group', '', group_key from public.evaluation_respondent_group",
        want_rows=True,
    )
    out = {"item": set(), "question": set(), "group": set()}
    for row in rows:
        out[row["t"]].add((row["a"], row["b"]))
    return out


def gate(plan: dict, actual: dict) -> list[str]:
    """Set equality in BOTH directions, per D5 and SITE-00 finding 4.

    Both directions, because each catches a different failure. A row in the
    document and not in the database is an edit that did not land, which is what
    a digest-skipping seed produces. A row in the database and not in the
    document is a retired item still being asked about, which nobody notices
    because the form looks fine.

    A count comparison catches neither: two sets of the same size can differ.
    """
    want = {"item": set(), "question": set(), "group": set()}
    for g in plan["groups"]:
        want["group"].add(("", g["group_key"]))
    for rnd in plan["rounds"]:
        r = plan["by_round"][rnd]
        for i in r["items"]:
            want["item"].add((r["round_key"], i["item_key"]))
        for q in r["questions"]:
            want["question"].add((r["round_key"], q["question_key"]))

    problems = []
    for kind in ("item", "question", "group"):
        missing = sorted(want[kind] - actual[kind])
        extra = sorted(actual[kind] - want[kind])
        if missing:
            problems.append(
                f"{kind}: {len(missing)} in the contract and NOT in the database "
                f"(the write did not land): " + ", ".join(f"{a}/{b}" for a, b in missing[:8])
            )
        if extra:
            problems.append(
                f"{kind}: {len(extra)} in the database and NOT in the contract "
                f"(a retired row still being asked about): "
                + ", ".join(f"{a}/{b}" for a, b in extra[:8])
            )
        if not missing and not extra:
            print(f"  gate {kind:<9} set-equal both directions, {len(want[kind])} rows")
    return problems


# --------------------------------------------------------------------------- #
# The management API
# --------------------------------------------------------------------------- #

def post_sql(sql: str, want_rows: bool = False):
    """Run as `postgres` through the management API, with the account denylist."""
    forbidden = {
        "vdbirmjvjzfdgajwgowj": "Honest Eval (repo `cairn`)",
        "ckorlrchryswnnrmuctr": "the Local Genres Research app",
    }
    secret = Path.home() / ".claude/secrets/obt-cdt-supabase.env"
    if not secret.exists():
        raise SeedError(f"no credentials at {secret}")
    env = {}
    for line in secret.read_text().split("\n"):
        if "=" in line and not line.strip().startswith("#"):
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip()
    ref = env.get("OBT_CDT_SUPABASE_PROJECT_REF", "")
    token = env.get("OBT_CDT_SUPABASE_ACCESS_TOKEN", "")
    if not ref or not token:
        raise SeedError(f"{secret} is missing the project ref or the access token")
    if ref in forbidden:
        raise SeedError(f"REFUSED: {ref} is {forbidden[ref]}, a different product.")

    import urllib.error
    import urllib.request

    # A stated User-Agent, because api.supabase.com answers urllib's default with
    # HTTP 403 Cloudflare 1010, which reads exactly like a bad token.
    request = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{ref}/database/query",
        data=json.dumps({"query": sql}).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "obt-cdt-seed-evaluation-instrument/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            body = response.read().decode()
    except urllib.error.HTTPError as exc:
        raise SeedError(f"management API {exc.code}: {exc.read().decode()[:600]}") from exc
    if want_rows:
        return json.loads(body) if body.strip() else []
    if body.strip() and body.strip() != "[]":
        print(f"  api: {body[:300]}")
    return None


def resolve_start_date(workshop: str) -> dt.date:
    rows = post_sql(
        f"select start_date from public.events where id = {lit(workshop)}", want_rows=True
    )
    if not rows:
        raise SeedError(
            f"no events row with id {workshop!r}. The round has to hang off a real "
            "workshop, because workshop_evaluation_round.workshop_key is a foreign key."
        )
    if not rows[0]["start_date"]:
        raise SeedError(
            f"the events row {workshop!r} has no start_date, so the round window "
            "cannot be defaulted. Pass --opens-at and --closes-at explicitly."
        )
    return dt.date.fromisoformat(rows[0]["start_date"])


# --------------------------------------------------------------------------- #

def kv(values: list[str], flag: str) -> dict[str, str]:
    out = {}
    for v in values or []:
        if "=" not in v:
            raise SeedError(f"{flag} takes round=timestamp, got {v!r}")
        rnd, _, ts = v.partition("=")
        if rnd not in ROUNDS:
            raise SeedError(f"{flag}: unknown round {rnd!r}")
        out[rnd] = ts
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--vault", default=str(DEFAULT_VAULT))
    ap.add_argument("--workshop", default=DEFAULT_WORKSHOP)
    ap.add_argument("--round", default="all", choices=[*ROUNDS, "all"])
    ap.add_argument("--emit-sql", metavar="PATH",
                    help="write the SQL and stop. Needs no credentials.")
    ap.add_argument("--apply", action="store_true",
                    help="write to the live project and run the set-equality gate")
    ap.add_argument("--print", dest="verbose", action="store_true",
                    help="list every item row as well as the counts")
    ap.add_argument("--allow-unsigned-session-map", action="store_true")
    ap.add_argument("--opens-at", action="append", metavar="ROUND=TS", default=[])
    ap.add_argument("--closes-at", action="append", metavar="ROUND=TS", default=[])
    args = ap.parse_args()

    try:
        args.opens_at = kv(args.opens_at, "--opens-at")
        args.closes_at = kv(args.closes_at, "--closes-at")

        # The window default needs the events row, which needs credentials. In
        # --emit-sql mode we may have none, so a fully-specified window is
        # required there rather than silently invented.
        if args.emit_sql and not args.apply:
            missing = [r for r in (list(ROUNDS) if args.round == "all" else [args.round])
                       if r not in args.opens_at or r not in args.closes_at]
            if missing:
                args.start_date = resolve_start_date(args.workshop)
            else:
                args.start_date = dt.date(1970, 1, 1)
        else:
            args.start_date = resolve_start_date(args.workshop)

        plan = build_plan(args)
        describe(plan, args.verbose)
        sql = build_sql(plan)

        if args.emit_sql:
            Path(args.emit_sql).write_text(sql, encoding="utf-8")
            print(f"\nwrote {args.emit_sql} ({len(sql.splitlines())} lines)")
            print("The set-equality gate did NOT run: it compares the contracts against "
                  "the database, and --emit-sql touches no database.")
            return 0

        if not args.apply:
            print("\nDRY RUN. Nothing was written. Add --apply to write, or "
                  "--emit-sql PATH to get the statements.")
            return 0

        print("\napplying...")
        post_sql(sql)
        print("gate:")
        problems = gate(plan, read_back(plan))
        if problems:
            print("\nGATE FAILED. The write ran but does not match the contracts:")
            for p in problems:
                print(f"  {p}")
            return 1
        print("\nseeded and gated.")
        return 0

    except (SeedError, ContractError) as exc:
        print(f"\nREFUSED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
