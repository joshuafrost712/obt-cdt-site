#!/usr/bin/env python3
"""Import a Google Form export into the evaluation tables, against the manifest.

    python3 scripts/import_evaluation_responses.py --round w1 --csv export.csv
    python3 scripts/import_evaluation_responses.py --round w1 --csv export.csv --apply

Spec SITE-01 D6, and the whole of program rubric row 6: "the manual fallback
loses nothing."

## It maps against the MANIFEST, not against the live map

This is the review's sharpest finding and it is a real defect avoided rather than
a refinement. `Session-Map.md` is a living document: its week-2 devotionals and
week 2 day 4 were blank when the August form was generated and Joshua closes them
on site, and any transcribed title may be corrected there too. This importer runs
in September. So the map that generated the form is GUARANTEED not to be the map
this script would read, and every corrected title would fail to map.

`build_evaluation_form.py` therefore froze a column manifest beside each delivered
Apps Script: the round key, the ordered emitted titles, the scale, the audience
label-to-key mapping, and the map's digest at generation time. That file is the
contract this script reads. Drift between the manifest and the current map is
reported as INFORMATION, because it is expected and harmless; an unmapped export
column is a REFUSAL, because it is an answer nobody would ever see again.

## Reserved columns are skipped by name, never by position

`Timestamp` is always column A. `Email Address` appears only if response-email
collection is switched on, and switching it on shifts every subsequent column by
one. A positional importer silently reads every answer into the wrong item.

## The identity problem, said out loud

The generated form asks for a NAME, optionally, and does not switch on email
collection. A name is not an identifier: two people called Matt are on this
workshop. So this script matches a response to a profile ONLY through an
`Email Address` column, and when that column is absent every response is
unattached and the run says so in one loud line rather than leaving somebody to
infer it from a zero.

Unattached is not a failure. An unattached response counts in the aggregate and
appears in the comment feed; what it loses is the participant's own ability to
read it back, which is D8 sentence 6 and criterion 14. Guessing from a name would
trade that small loss for a wrong attribution, which is much worse.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_evaluation_form import (  # noqa: E402
    ContractError,
    DEFAULT_VAULT,
    EVAL_SUBDIR,
    QUESTION_SET_NAME,
    SESSION_MAP_NAME,
    compute_digest,
    derive_keys,
    emitted_title,
    parse_question_set,
    parse_session_map,
)
from seed_evaluation_instrument import SeedError, lit, post_sql  # noqa: E402

DEFAULT_WORKSHOP = "psalms-bali-2026"
MANIFEST_NAME = {"w1": "Round-1-Columns.json", "w2": "Round-2-Columns.json"}

# The keys this importer needs on every column. They were added to the manifest
# format on 2026-08-28 with the aggregate round shape, and a manifest generated
# before that lacks them. Refusing is the only safe answer: `scale_mapped` is what
# tells this script that an aggregate round's three block ratings are ratings, and
# without it they would be imported as text bodies into scale-shaped questions and
# refused by a foreign key with no explanation.
REQUIRED_COLUMN_KEYS = {
    "position", "column_kind", "item_key", "question_key", "participant_key",
    "title", "required", "question_kind", "scale_mapped", "absence_option",
}
REQUIRED_TOP_KEYS = {
    "round", "form_shape", "source_digest", "source_files", "scale", "audience",
    "columns",
    # Read with .get() elsewhere, but required here so that a manifest without it
    # gives the clear old-manifest refusal rather than the confusing
    # "1 export column matches nothing: 'Timestamp'".
    "reserved_columns",
}


class ImportError_(Exception):
    pass


# --------------------------------------------------------------------------- #
# The manifest
# --------------------------------------------------------------------------- #

def load_manifest(path: Path, rnd: str) -> dict:
    if not path.exists():
        raise ImportError_(
            f"no manifest at {path}\n"
            f"  It is written beside the delivered Apps Script by:\n"
            f"    python3 scripts/build_evaluation_form.py --round {rnd} --write\n"
            "  Without it this importer would have to re-derive the column titles\n"
            "  from Session-Map.md as it stands today, which is the exact failure\n"
            "  rubric row 6 exists to prevent."
        )
    manifest = json.loads(path.read_text(encoding="utf-8"))

    missing_top = REQUIRED_TOP_KEYS - set(manifest)
    if missing_top:
        raise ImportError_(
            f"{path.name} is an OLD manifest: it has no {', '.join(sorted(missing_top))}.\n"
            "  The format gained form_shape and the per-column question_kind /\n"
            "  scale_mapped / absence_option keys on 2026-08-28, with the aggregate\n"
            "  round shape. Regenerate it:\n"
            f"    python3 scripts/build_evaluation_form.py --round {rnd} --write\n"
            "  and re-deliver the Apps Script if the form has not been built yet.\n"
            "  This is a refusal rather than a fallback because scale_mapped is what\n"
            "  distinguishes a block rating from a written answer, and guessing it\n"
            "  from column_kind drops every rating on an aggregate round."
        )
    if manifest["round"] != rnd:
        raise ImportError_(
            f"{path.name} is round {manifest['round']!r}, not {rnd!r}."
        )
    for col in manifest["columns"]:
        gap = REQUIRED_COLUMN_KEYS - set(col)
        if gap:
            raise ImportError_(
                f"{path.name} column {col.get('position')} "
                f"({col.get('title', '')[:40]!r}) has no {', '.join(sorted(gap))}. "
                "Regenerate the manifest; see the message above."
            )
    return manifest


def manifest_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def report_drift(manifest: dict, vault: Path, rnd: str) -> None:
    """Manifest titles versus the map as it stands. Information, not a failure.

    Expected, because Joshua closes the map's blank rows on site after the form
    goes out. Printed because a title that moved is the reason an item_key in the
    portal reads differently from the column it was imported from, and a session
    six weeks later should not have to work that out.
    """
    smap = vault / EVAL_SUBDIR / SESSION_MAP_NAME
    qset = vault / EVAL_SUBDIR / QUESTION_SET_NAME
    if not smap.exists() or not qset.exists():
        print("  drift: the contract documents are not readable from here, so the "
              "manifest could not be compared against them. The import is unaffected.")
        return

    sources = {
        SESSION_MAP_NAME: smap.read_text(encoding="utf-8"),
        QUESTION_SET_NAME: qset.read_text(encoding="utf-8"),
    }
    now_digest, _ = compute_digest(sources)
    if now_digest == manifest["source_digest"]:
        print("  drift: none. The contracts are byte-identical to when the form was "
              "generated.")
        return

    rows, _ = parse_session_map(sources[SESSION_MAP_NAME], str(smap))
    derive_keys(rows, str(smap))
    now_titles = {r["item_key"]: emitted_title(r) for r in rows if r["round"] == rnd}

    # Question PROMPTS as well as item titles. On an `aggregate` round no item is
    # a column at all, so a drift report that compared only item titles would be
    # blind to every column that round actually has, and would report "nothing
    # moved" on the one round where a moved column is possible.
    qs = parse_question_set(sources[QUESTION_SET_NAME], str(qset))
    now_prompts = {
        q["question_key"]: q["prompt"]
        for q in qs["questions"] if q["round"] in (rnd, "both")
    }

    moved = []
    for col in manifest["columns"]:
        key = col["item_key"]
        if key and key in now_titles and now_titles[key] != col["title"]:
            moved.append((key, col["title"], now_titles[key]))
        qkey = col["question_key"]
        if qkey and qkey in now_prompts and now_prompts[qkey] != col["title"]:
            moved.append((qkey, col["title"], now_prompts[qkey]))

    print(f"  drift: the contracts have changed since generation "
          f"({manifest['source_digest'][:12]}… -> {now_digest[:12]}…).")
    if not moved:
        print("         No column title moved, so nothing about this import changes.")
    else:
        print(f"         {len(moved)} column title(s) moved. The import maps on the "
              "manifest's titles, which is correct; the portal shows the map's.")
        for key, was, now in moved[:10]:
            print(f"           {key}: {was!r}")
            print(f"                 -> {now!r}")


# --------------------------------------------------------------------------- #
# The export
# --------------------------------------------------------------------------- #

def map_headers(headers: list[str], manifest: dict) -> tuple[dict[int, dict], list[str]]:
    """Export column index -> manifest column. Reserved skipped BY NAME.

    An export header that matches nothing STOPS the import. It is the signature
    of a form edited by hand after generation, and the alternative to stopping is
    discarding somebody's answer without telling anyone.
    """
    reserved = {r["title"] for r in manifest.get("reserved_columns", [])}

    # Review finding 8. `{c["title"]: c for c in ...}` collapses two columns
    # sharing a title to the last one, and the missing-column check below still
    # sees both titles present, so nothing refuses and one item's answers land
    # under another item's key. build_evaluation_form.py refuses duplicate
    # emitted titles when it GENERATES the manifest; that refusal has to be
    # re-checked here, because this script may be reading a manifest an older
    # generator wrote.
    seen: dict[str, dict] = {}
    dupes: list[str] = []
    for c in manifest["columns"]:
        if c["title"] in seen:
            dupes.append(
                f"{c['title']!r}: columns {seen[c['title']]['position']} and {c['position']}"
            )
        seen[c["title"]] = c
    if dupes:
        raise ImportError_(
            "the manifest carries duplicate column titles, which Google cannot "
            "keep apart in an export:\n"
            + "".join(f"    {d}\n" for d in dupes)
            + "  Change a title in the contract and regenerate the manifest."
        )
    by_title = seen

    mapped: dict[int, dict] = {}
    skipped: list[str] = []
    unknown: list[str] = []
    for i, h in enumerate(headers):
        title = h.strip()
        if title in reserved:
            skipped.append(title)
            continue
        if title in by_title:
            mapped[i] = by_title[title]
            continue
        unknown.append(title)

    if unknown:
        raise ImportError_(
            f"{len(unknown)} export column(s) match nothing in the manifest and "
            "nothing in the reserved list:\n"
            + "".join(f"    {t!r}\n" for t in unknown[:12])
            + "  An unmapped column is an answer that would be silently dropped, so\n"
            "  the import stops. Either the form was edited after generation, or\n"
            "  this is the wrong manifest for this export."
        )

    absent = [c["title"] for c in manifest["columns"]
              if c["title"] not in {h.strip() for h in headers}]
    if absent:
        raise ImportError_(
            f"{len(absent)} manifest column(s) are missing from the export:\n"
            + "".join(f"    {t!r}\n" for t in absent[:12])
            + "  Google writes a column for every question whether or not anyone\n"
            "  answered it, so a missing column means the delivered form is not the\n"
            "  generated one."
        )
    return mapped, skipped


def scale_lookup(manifest: dict) -> dict[str, dict]:
    return {s["choice"]: s for s in manifest["scale"]}


def group_lookup(manifest: dict) -> dict[str, str]:
    return {g["label"]: g["group_key"] for g in manifest["audience"]["groups"]}


def parse_rows(reader, mapped, manifest, round_key) -> tuple[list[dict], list[str], list[str]]:
    """Returns (responses, problems, blocking).

    `problems` are reported and the import continues; `blocking` stops it. The
    split matters: a missing optional answer is information, and a row the
    schema cannot represent is a refusal.
    """
    scale = scale_lookup(manifest)
    groups = group_lookup(manifest)
    responses: list[dict] = []
    problems: list[str] = []
    blocking: list[str] = []

    for n, raw in enumerate(reader, start=2):
        resp = {
            "row": n, "email": None, "name": None, "group": None,
            "ratings": [], "answers": [],
        }
        for i, col in mapped.items():
            value = (raw[i] if i < len(raw) else "").strip()

            if col["column_kind"] == "identity":
                resp["name"] = value or None
                continue

            if col["column_kind"] == "audience":
                if not value:
                    problems.append(f"row {n}: no answer to the required audience question")
                elif value not in groups:
                    problems.append(
                        f"row {n}: audience answer {value!r} is not one of the "
                        f"manifest's labels ({', '.join(groups)})"
                    )
                else:
                    resp["group"] = groups[value]
                continue

            if not value:
                continue   # an unanswered optional question is not a row

            if col["scale_mapped"]:
                if value not in scale:
                    problems.append(
                        f"row {n}, {col['title'][:40]!r}: {value!r} is not one of the "
                        "manifest's scale choices"
                    )
                    continue
                s = scale[value]
                if not s["attended"] and not col["absence_option"]:
                    problems.append(
                        f"row {n}, {col['title'][:40]!r}: answered "
                        f"{value!r}, but this question offers no absence option"
                    )
                    continue
                target = resp["ratings"] if col["column_kind"] == "rating" else resp["answers"]
                entry = {"attended": s["attended"], "rating": s["rating"]}
                if col["column_kind"] == "rating":
                    entry["item_key"] = col["item_key"]
                else:
                    entry["question_key"] = col["question_key"]
                target.append(entry)
                continue

            if col["column_kind"] == "comment":
                # A comment rides on the rating row for the same item, so it is
                # stashed and merged after the whole row is read: Google puts the
                # rating and its comment box in adjacent columns but nothing
                # guarantees the order.
                resp.setdefault("comments", {})[col["item_key"]] = value
                continue

            resp["answers"].append({"question_key": col["question_key"], "body": value})

        for item_key, text in (resp.get("comments") or {}).items():
            for r in resp["ratings"]:
                if r.get("item_key") == item_key:
                    r["comment"] = text
                    break
            else:
                # A comment with no rating beside it, and this REFUSES rather
                # than coercing. Review finding 2: the first version built
                # `attended=True, rating=None`, which is precisely the corner
                # `evaluation_item_rating_scale` was rewritten to forbid, so the
                # row would have raised 23514 at apply time, mid-file.
                #
                # The two coercions both lie. `attended=false` says "I wasn't
                # there" about someone who wrote a paragraph about being there;
                # `attended=true, rating=null` is a state the schema does not
                # have. Every rating column on the generated form is required,
                # so this can only arise from a form edited after generation,
                # and the honest response to an edited form is the same one the
                # unknown-column path already gives: stop and name it.
                blocking.append(
                    f"row {n}: a comment on {item_key} with no rating beside it. "
                    "The rating question is required on the generated form, so "
                    "this export came from an edited form. There is no way to "
                    "store this that is not a claim the participant did not "
                    "make: fix the form or delete the stray comment."
                )
        resp.pop("comments", None)
        responses.append(resp)

    return responses, problems, blocking


# --------------------------------------------------------------------------- #
# Attaching
# --------------------------------------------------------------------------- #

def attach(responses: list[dict], have_email_column: bool) -> dict:
    """Match a response to a profile, by email only, never by name."""
    if not have_email_column:
        return {"mode": "none", "matched": 0, "unmatched": 0, "pairs": []}

    from seed_allowlist import near_duplicates

    addresses = sorted({r["email"].lower() for r in responses if r["email"]})
    if not addresses:
        return {"mode": "email", "matched": 0, "unmatched": len(responses), "pairs": []}

    quoted = ", ".join(lit(a) for a in addresses)
    rows = post_sql(
        "select p.id, lower(p.email) as email from public.profiles p "
        f"where lower(p.email) in ({quoted})",
        want_rows=True,
    )
    known = {r["email"]: r["id"] for r in rows}
    matched = 0
    for r in responses:
        addr = (r["email"] or "").lower()
        r["profile_id"] = known.get(addr)
        if r["profile_id"]:
            matched += 1
    return {
        "mode": "email",
        "matched": matched,
        "unmatched": len(responses) - matched,
        "pairs": near_duplicates(addresses),
    }


# --------------------------------------------------------------------------- #

def build_sql(responses, round_key, import_row) -> str:
    out = [
        "-- scripts/import_evaluation_responses.py, spec SITE-01 D6. Generated.",
        f"-- round {round_key}  responses {len(responses)}",
        "insert into public.evaluation_import",
        "  (id, round_key, source_file, source_digest, manifest_file, manifest_digest,",
        "   rows_read, rows_imported, rows_unattached, operator) values (",
        f"  {lit(import_row['id'])}, {lit(round_key)}, {lit(import_row['source_file'])},",
        f"  {lit(import_row['source_digest'])}, {lit(import_row['manifest_file'])},",
        f"  {lit(import_row['manifest_digest'])}, {import_row['rows_read']},",
        f"  {import_row['rows_imported']}, {import_row['rows_unattached']},",
        f"  {lit(import_row['operator'])});",
        "",
    ]
    for r in responses:
        rid = r["_id"]
        out += [
            "insert into public.evaluation_response",
            "  (id, round_key, profile_id, respondent_group, state, source, import_id, submitted_at)",
            f"  values ({lit(rid)}, {lit(round_key)}, {lit(r.get('profile_id'))},",
            f"  {lit(r.get('group'))}, 'submitted', 'manual', {lit(import_row['id'])}, now());",
        ]
        for x in r["ratings"]:
            out.append(
                "insert into public.evaluation_item_rating"
                " (response_id, round_key, item_key, attended, rating, comment) values ("
                f"{lit(rid)}, {lit(round_key)}, {lit(x['item_key'])}, {lit(x['attended'])},"
                f" {lit(x['rating'])}, {lit(x.get('comment'))});"
            )
        for x in r["answers"]:
            if "body" in x:
                out.append(
                    "insert into public.evaluation_answer"
                    " (response_id, round_key, question_key, answer_shape, absence_allowed, body)"
                    f" select {lit(rid)}, {lit(round_key)}, {lit(x['question_key'])},"
                    " q.answer_shape, q.absence_allowed, " + lit(x["body"]) +
                    " from public.evaluation_question q"
                    f" where q.round_key = {lit(round_key)} and q.question_key = {lit(x['question_key'])};"
                )
            else:
                out.append(
                    "insert into public.evaluation_answer"
                    " (response_id, round_key, question_key, answer_shape, absence_allowed,"
                    " attended, rating)"
                    f" select {lit(rid)}, {lit(round_key)}, {lit(x['question_key'])},"
                    " q.answer_shape, q.absence_allowed, "
                    f"{lit(x['attended'])}, {lit(x['rating'])}"
                    " from public.evaluation_question q"
                    f" where q.round_key = {lit(round_key)} and q.question_key = {lit(x['question_key'])};"
                )
        out.append("")

    # Review finding 3, and it is the module docstring's own promise arriving one
    # layer down. Answers are written with `insert … select … from
    # evaluation_question`, so a question_key absent from the seeded round
    # matches nothing and the statement writes ZERO rows with no error, while
    # item ratings use a plain VALUES insert and fail loudly with 23503. Two
    # halves of one import failing in opposite ways is worse than either.
    #
    # So the file ends by counting what actually landed against what it meant to
    # write, and raising if they differ. A silent drop becomes a refusal, and the
    # whole import rolls back with it.
    expected_answers = sum(len(r["answers"]) for r in responses)
    expected_ratings = sum(len(r["ratings"]) for r in responses)
    out += [
        "do $$",
        "declare _a int; _r int;",
        "begin",
        f"  select count(*) into _a from public.evaluation_answer"
        f"   where response_id in (select id from public.evaluation_response"
        f"                          where import_id = {lit(import_row['id'])});",
        f"  select count(*) into _r from public.evaluation_item_rating"
        f"   where response_id in (select id from public.evaluation_response"
        f"                          where import_id = {lit(import_row['id'])});",
        f"  if _a <> {expected_answers} then",
        f"    raise exception 'the import meant to write {expected_answers} answer(s) "
        f"and % landed. An insert-select whose question_key is absent from the seeded "
        f"round writes nothing and raises nothing, so this is a silent drop caught by "
        f"counting. Seed the instrument for this round first.', _a;",
        "  end if;",
        f"  if _r <> {expected_ratings} then",
        f"    raise exception 'the import meant to write {expected_ratings} rating(s) "
        f"and % landed.', _r;",
        "  end if;",
        f"  raise notice 'import verified: % answer(s), % rating(s)', _a, _r;",
        "end $$;",
    ]

    # And the whole thing is one transaction. Without it a row refused halfway
    # leaves a partial import PLUS an evaluation_import row whose rows_imported
    # is a lie about what is in the database.
    return "begin;\n" + "\n".join(out) + "\ncommit;\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--round", required=True, choices=["w1", "w2"])
    ap.add_argument("--csv", required=True)
    ap.add_argument("--vault", default=str(DEFAULT_VAULT))
    ap.add_argument("--workshop", default=DEFAULT_WORKSHOP)
    ap.add_argument("--manifest", help="override the manifest path")
    ap.add_argument("--operator", default="claude-code")
    ap.add_argument("--emit-sql", metavar="PATH")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    try:
        import uuid

        vault = Path(args.vault)
        mpath = Path(args.manifest) if args.manifest else (
            vault / EVAL_SUBDIR / MANIFEST_NAME[args.round]
        )
        manifest = load_manifest(mpath, args.round)
        round_key = f"{args.workshop}:{args.round}"

        csv_path = Path(args.csv)
        if not csv_path.exists():
            raise ImportError_(f"no export at {csv_path}")

        print(f"round      {round_key}")
        print(f"manifest   {mpath.name}  generated {manifest['generated_on']}  "
              f"shape {manifest['form_shape']}")
        print(f"export     {csv_path.name}")
        report_drift(manifest, vault, args.round)

        with csv_path.open(newline="", encoding="utf-8-sig") as fh:
            reader = csv.reader(fh)
            headers = next(reader, None)
            if not headers:
                raise ImportError_(f"{csv_path} is empty")
            mapped, skipped = map_headers(headers, manifest)
            responses, problems, blocking = parse_rows(reader, mapped, manifest, round_key)

        have_email = "Email Address" in {h.strip() for h in headers}
        if have_email:
            idx = [i for i, h in enumerate(headers) if h.strip() == "Email Address"][0]
            with csv_path.open(newline="", encoding="utf-8-sig") as fh:
                rd = csv.reader(fh)
                next(rd)
                for r, raw in zip(responses, rd):
                    r["email"] = (raw[idx] if idx < len(raw) else "").strip() or None

        print(f"\ncolumns    {len(mapped)} mapped, {len(skipped)} reserved skipped by name"
              + (f" ({', '.join(skipped)})" if skipped else ""))
        print(f"responses  {len(responses)}")
        n_ratings = sum(len(r['ratings']) for r in responses)
        n_answers = sum(len(r['answers']) for r in responses)
        print(f"           {n_ratings} item rating(s), {n_answers} answer(s)")
        # Counted across BOTH lists, because on an aggregate round every rating
        # is a question and none of them is in `ratings`. Counting only the item
        # list reports zero absences on the round that has nothing but block
        # ratings, which is the manifest's own warning arriving in the report
        # instead of in the mapping.
        absent = sum(1 for r in responses
                     for x in (r["ratings"] + r["answers"])
                     if x.get("attended") is False)
        scale_answers = sum(1 for r in responses for x in r["answers"] if "body" not in x)
        print(f"           of the answers, {scale_answers} are block ratings "
              f"({n_answers - scale_answers} written)")
        print(f"           {absent} rating(s) in all are \"I wasn't there\" "
              "(attended false, rating null, never zero)")

        info = attach(responses, have_email)
        if info["mode"] == "none":
            print("\nattach     EVERY response is unattached, because this export has no")
            print("           'Email Address' column. The generated form does not switch")
            print("           response-email collection on, and a name is not an")
            print("           identifier, so nothing here is matched to an account.")
            print("           These responses count in the aggregate and appear in the")
            print("           comment feed; what they lose is the participant's own")
            print("           ability to read them back. That is D8 sentence 6.")
        else:
            print(f"\nattach     {info['matched']} matched by email, "
                  f"{info['unmatched']} left unattached rather than guessed")
            for pair in info["pairs"]:
                print("           near-duplicate address: " + "  ~  ".join(pair))

        if problems:
            print(f"\n{len(problems)} row problem(s), reported and not fatal:")
            for p in problems[:20]:
                print(f"  {p}")

        if blocking:
            raise ImportError_(
                f"{len(blocking)} row(s) cannot be represented, so nothing was imported:\n"
                + "".join(f"    {b}\n" for b in blocking[:20])
            )

        for r in responses:
            r["_id"] = str(uuid.uuid4())
        import_row = {
            "id": str(uuid.uuid4()),
            "source_file": csv_path.name,
            "source_digest": hashlib.sha256(csv_path.read_bytes()).hexdigest(),
            "manifest_file": mpath.name,
            "manifest_digest": manifest_digest(mpath),
            "rows_read": len(responses),
            "rows_imported": len(responses),
            "rows_unattached": sum(1 for r in responses if not r.get("profile_id")),
            "operator": args.operator,
        }
        sql = build_sql(responses, round_key, import_row)

        if args.emit_sql:
            Path(args.emit_sql).write_text(sql, encoding="utf-8")
            print(f"\nwrote {args.emit_sql}")
            return 0
        if not args.apply:
            print("\nDRY RUN. Nothing was written. Add --apply, or --emit-sql PATH.")
            return 0

        post_sql(sql)
        print(f"\nimported {len(responses)} response(s) as import {import_row['id']}")
        return 0

    except (ImportError_, SeedError, ContractError) as exc:
        print(f"\nREFUSED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
