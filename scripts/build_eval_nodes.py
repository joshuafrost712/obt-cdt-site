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

## `--check` has two modes, and it always says which one it ran

The contract is a document in Joshua's private vault. This script is in
`npm run build`, and `npm run build` runs in GitHub Actions, where that document
does not exist and never will. The first version read the path unconditionally
and died on `FileNotFoundError`, which broke every deploy from 2026-09-04, the
day the line entered `npm run build` in 4c72f5b, until it was found on 09-08 —
locally green, on the runner red, in the one gate whose whole purpose is to
notice that two things disagree.

Passing when the contract is absent is not the fix: a check that reports success
over an input it could not read is this campaign's signature defect, and the
absent input here is the entire population. So `--apply` also writes
`scripts/eval-nodes.lock.json`, holding the nodes it generated and the sha256 of
the contract they came from, and `--check` compares against whichever it has:

  * contract present  — parse it, regenerate, compare `site-content.json`, AND
    assert the lock still matches the contract, so the lock cannot go stale
    unnoticed on the machine that owns it.
  * contract absent   — compare `site-content.json` against the lock, name the
    contract digest the lock was cut from, and say plainly that the contract
    itself was not read.

A real drift turns both modes red. A missing lock is a failure and not a skip,
because that is the state in which there is nothing to check.

## The lock's population is asserted in BOTH directions, and zero is a refusal

The stage-6 review of 2026-09-08 found the vacuous pass this file's own docstring
had ruled out one paragraph earlier. An EMPTY `nodes` array is the same state as
a missing lock — nothing to check — and it passed, because `merge()` over no
nodes reports no drift. `[].every()` is true; this campaign has now shipped that
shape four times.

Two rules close it, and the second is the one the first version missed entirely.
The lock must be NON-EMPTY, checked before it is used. And the comparison runs
BOTH WAYS: `merge()` only asks whether every locked node is in the file, so a
lock that OMITS an id the file still carries is invisible to it. `--check` now
also asserts the lock accounts for every `portal.eval.*` id under this script's
own prefixes, so dropping an id from the lock cannot quietly narrow the gate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CONTENT = REPO / "src/content/site-content.json"
LOCK = REPO / "scripts/eval-nodes.lock.json"

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


def contract_digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def write_lock(nodes: list[dict], path: Path, digest: str) -> None:
    """The record CI checks against, because CI cannot read the contract."""
    payload = {
        "_": "Written by scripts/build_eval_nodes.py --apply. Do not hand-edit: "
             "it is what `--check` compares against wherever the vault contract "
             "is not on the machine, which is every CI run.",
        "contract": str(path),
        "contract_sha256": digest,
        "nodes": nodes,
    }
    LOCK.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def read_lock() -> dict:
    if not LOCK.exists():
        raise SystemExit(
            f"REFUSED: {LOCK.relative_to(REPO)} is missing, and without the vault "
            "contract there is nothing to check the eval nodes against.\n"
            "On a machine with the vault: python3 scripts/build_eval_nodes.py --apply"
        )
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    # An empty population is the same state as a missing lock, and it used to
    # pass. Stage-6 review, 2026-09-08.
    if not lock.get("nodes"):
        raise SystemExit(
            f"REFUSED: {LOCK.relative_to(REPO)} holds no nodes. An empty lock is "
            "the state this check exists to refuse, not a check that found "
            "nothing wrong.\n"
            "On a machine with the vault: python3 scripts/build_eval_nodes.py --apply"
        )
    if not lock.get("contract_sha256"):
        raise SystemExit(f"REFUSED: {LOCK.relative_to(REPO)} names no contract digest.")
    return lock


def is_owned_id(node_id: str) -> bool:
    """The namespace this script generates, which is NOT the whole `portal.eval.`
    prefix. Most `portal.eval.*` nodes are SITE-02's own hand-written copy, which
    the docstring above says this script leaves alone: there are 77 nodes under
    the prefix and 13 of them are generated. The first version of the coverage
    check used the bare prefix and refused every build, which is the cheapest
    possible way to learn that an ownership boundary has to be stated, not
    guessed from a common ancestor."""
    return (
        node_id.startswith(f"{PREFIX}scale.")
        or node_id.startswith(f"{PREFIX}prompt.")
        or node_id == f"{PREFIX}group.prompt"
    )


def assert_lock_covers_file(nodes: list[dict], data: dict) -> None:
    """Both directions. `merge()` asks whether every locked node is in the file;
    this asks whether every owned id in the file is in the lock, so an id
    dropped from the lock cannot silently narrow what is checked."""
    locked = owned_ids(nodes)
    in_file = {
        item["id"]
        for item in data["site"]["items"]
        if isinstance(item.get("id"), str) and is_owned_id(item["id"])
    }
    missing = sorted(in_file - locked)
    if missing:
        raise SystemExit(
            f"REFUSED: {len(missing)} node id(s) under {PREFIX!r} are in "
            "site-content.json and absent from the lock, so nothing checks them:\n"
            + "".join(f"  {i}\n" for i in missing)
            + "On a machine with the vault: python3 scripts/build_eval_nodes.py --apply"
        )


def report_drift(changed: list[str], added: list[str], against: str, fix: str) -> int:
    print(
        f"site-content.json has drifted from {against}:\n"
        + "".join(f"  changed  {i}\n" for i in changed)
        + "".join(f"  missing  {i}\n" for i in added)
        + f"\n{fix}",
        file=sys.stderr,
    )
    return 1


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
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        # The contract lives in the vault and this script runs in CI. Only
        # --check has an answer without it; --print and --apply need the source.
        if not args.check:
            print(
                f"the contract is not on this machine: {path}\n"
                "--print and --apply need it. Set OBT_CDT_VAULT or pass "
                "--question-set. Only --check can run without it, against "
                f"{LOCK.relative_to(REPO)}.",
                file=sys.stderr,
            )
            return 1
        lock = read_lock()
        nodes = lock["nodes"]
        data, raw = load_content()
        assert_round_trip(data, raw)
        assert_lock_covers_file(nodes, data)
        _, changed, added = merge(data, nodes)
        if changed or added:
            return report_drift(
                changed,
                added,
                f"{LOCK.name} (cut from {Path(lock['contract']).name} "
                f"@ {lock['contract_sha256'][:16]})",
                "On a machine with the vault: python3 scripts/build_eval_nodes.py --apply",
            )
        print(
            f"build_eval_nodes: {len(nodes)} node(s) match {LOCK.name}, cut from "
            f"{Path(lock['contract']).name} @ {lock['contract_sha256'][:16]}. "
            "The contract itself was NOT read; it is not on this machine."
        )
        return 0

    try:
        qs = parse_question_set(text, str(path))
    except ContractError as e:
        print(f"the contract refused: {e}", file=sys.stderr)
        return 1

    digest = contract_digest(text)
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
            return report_drift(
                changed, added, path.name,
                "Re-run: python3 scripts/build_eval_nodes.py --apply",
            )
        # The lock is what CI checks against, so a stale lock is a gate that
        # has stopped watching. Only the machine holding the contract can see it.
        lock = read_lock()
        assert_lock_covers_file(lock["nodes"], data)
        if lock["nodes"] != nodes or lock["contract_sha256"] != digest:
            print(
                f"{LOCK.relative_to(REPO)} is stale: it no longer matches "
                f"{path.name}. site-content.json is correct, so CI is checking "
                "against an out-of-date record.\n"
                "Re-run: python3 scripts/build_eval_nodes.py --apply",
                file=sys.stderr,
            )
            return 1
        print(f"build_eval_nodes: {len(nodes)} node(s) match {path.name}, and {LOCK.name} is current")
        return 0

    CONTENT.write_text(dump(data), encoding="utf-8")
    write_lock(nodes, path, digest)
    print(f"wrote {len(nodes)} node(s): {len(changed)} changed, {len(added)} added")
    for i in changed + added:
        print(f"  {i}")
    print(f"wrote {LOCK.relative_to(REPO)} @ contract {digest[:16]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
