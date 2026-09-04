#!/usr/bin/env python3
"""Write the evaluation form's contract-owned strings into site-content.json.

Spec SITE-02 D2, and program rubric row 4: every rateable item and question comes
from a signed contract document, never from a literal in a script.

    python3 scripts/build_eval_nodes.py --print      # what it would write
    python3 scripts/build_eval_nodes.py --apply      # write it
    python3 scripts/build_eval_nodes.py --check      # exit 1 if the file has drifted

## Which strings, and why only these

Four groups of `portal.eval.*` nodes, and every one of them is a sentence
`Question-Set.md` already owns:

  * `portal.eval.scale.1` .. `.5` and `.absent` — the six choice strings.
  * `portal.eval.scale.note` — the sentence that makes the scale mean one thing.
  * `portal.eval.prompt.<kind>` — the five comment prompts, one per item kind.
  * `portal.eval.group.prompt` — the audience question.

SITE-02's finding 4 is why. A hard-coded option list in the page means Joshua can
reword scale point 2 in the contract while the portal keeps the old wording and
the integer stays 2, and the portal instrument then silently diverges from the
Google Form on the exact column the campaign exists to protect. The audience
GROUP LABELS are deliberately absent from this list: they are already contract
-driven the other way round, seeded into `evaluation_respondent_group` by
`seed_evaluation_instrument.py` and rendered from the database.

Every other `portal.eval.*` node is this spec's own copy, written by hand and
edited in place by Joshua in `npm run dev`, and this script leaves those alone: it
replaces exactly the ids it generates and touches nothing else in the file.

## The round trip is asserted before the file is written

SITE-06's finding 11, carried by SITE-05's D8 and now by this script:
`site-content.json` is read and re-dumped by more than one generator, so a script
that reformats it makes the next one refuse. `json.dumps(..., indent=2,
ensure_ascii=False)` plus a trailing newline reproduces the file byte for byte,
and this asserts that BEFORE it edits anything rather than discovering it in a
diff of 8,000 lines.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CONTENT = REPO / "src/content/site-content.json"

sys.path.insert(0, str(REPO / "scripts"))
from build_evaluation_form import (  # noqa: E402
    DEFAULT_VAULT,
    EVAL_SUBDIR,
    QUESTION_SET_NAME,
    ContractError,
    parse_question_set,
)


def default_question_set() -> Path:
    return DEFAULT_VAULT / EVAL_SUBDIR / QUESTION_SET_NAME

PREFIX = "portal.eval."


def generated_nodes(qs: dict) -> list[dict]:
    """The ids this script owns, in the order they are written."""
    out: list[dict] = []
    for point in qs["scale"]:
        rating = point["rating"]
        suffix = "absent" if rating is None else str(rating)
        out.append({"id": f"{PREFIX}scale.{suffix}", "type": "labelToken", "label": point["choice"]})
    out.append({"id": f"{PREFIX}scale.note", "type": "labelToken", "label": qs["sentence"]})
    for kind in sorted(qs["prompts"]):
        out.append({"id": f"{PREFIX}prompt.{kind}", "type": "labelToken", "label": qs["prompts"][kind]})
    out.append({"id": f"{PREFIX}group.prompt", "type": "labelToken", "label": qs["audience"]["prompt"]})
    return out


def owned_ids(nodes: list[dict]) -> set[str]:
    return {n["id"] for n in nodes}


def load_content() -> tuple[dict, str]:
    raw = CONTENT.read_text(encoding="utf-8")
    data = json.loads(raw)
    return data, raw


def dump(data: dict) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def assert_round_trip(data: dict, raw: str) -> None:
    if dump(data) != raw:
        raise SystemExit(
            "REFUSED: src/content/site-content.json does not survive a read/write "
            "round trip with indent=2, ensure_ascii=False and a trailing newline.\n"
            "Writing it would reformat the whole file and make every other "
            "generator refuse (SITE-06 finding 11). Fix the formatting first."
        )


def merge(data: dict, nodes: list[dict]) -> tuple[list[dict], list[str], list[str]]:
    """Replace the owned ids in place; append the ones that do not exist yet."""
    items = data["site"]["items"]
    mine = owned_ids(nodes)
    by_id = {n["id"]: n for n in nodes}
    changed: list[str] = []
    added: list[str] = []

    for i, item in enumerate(items):
        if item.get("id") in mine:
            new = by_id[item["id"]]
            if item != new:
                changed.append(item["id"])
            items[i] = new

    present = {item.get("id") for item in items}
    for n in nodes:
        if n["id"] not in present:
            items.append(n)
            added.append(n["id"])

    # An id sorts where it lands; the file's own order is not alphabetical and
    # re-sorting it would be a reformat by another name.
    return items, changed, added


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--print", action="store_true", dest="do_print")
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--check", action="store_true")
    ap.add_argument("--question-set", default=None)
    args = ap.parse_args()

    path = Path(args.question_set) if args.question_set else default_question_set()
    try:
        qs = parse_question_set(path.read_text(encoding="utf-8"), str(path))
    except ContractError as e:
        print(f"the contract refused: {e}", file=sys.stderr)
        return 1

    nodes = generated_nodes(qs)
    data, raw = load_content()
    assert_round_trip(data, raw)

    existing = {item["id"]: item for item in data["site"]["items"] if "id" in item}
    if args.do_print:
        print(f"contract  {path}")
        print(f"{len(nodes)} generated node(s):\n")
        for n in nodes:
            state = "NEW" if n["id"] not in existing else ("same" if existing[n["id"]] == n else "CHANGED")
            print(f"  {state:8} {n['id']}")
            print(f"           {n['label']}")
        return 0

    _, changed, added = merge(data, nodes)

    if args.check:
        if changed or added:
            print(
                "site-content.json has drifted from Question-Set.md:\n"
                + "".join(f"  changed  {i}\n" for i in changed)
                + "".join(f"  missing  {i}\n" for i in added)
                + "\nRe-run: python3 scripts/build_eval_nodes.py --apply",
                file=sys.stderr,
            )
            return 1
        print(f"build_eval_nodes: {len(nodes)} node(s) match {path.name}")
        return 0

    CONTENT.write_text(dump(data), encoding="utf-8")
    print(f"wrote {len(nodes)} node(s): {len(changed)} changed, {len(added)} added")
    for i in changed + added:
        print(f"  {i}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
