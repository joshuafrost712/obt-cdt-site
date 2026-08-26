#!/usr/bin/env python3
"""Generate the Bali Psalms evaluation form from its two contract documents.

Spec SITE-00 D3. Reads `Session-Map.md` (what is rateable) and `Question-Set.md`
(the scale, the comment prompts, the reflective questions), both in the vault, and
emits the Apps Script source that builds one round's Google Form, plus the frozen
column manifest the September importer will read.

Why a script and not hand-typed Apps Script: **the column titles must have exactly
one author.** A Google Forms export has no stable per-item id, so the column header
IS the key (SITE-00 finding 2). The same function writes a title into the Apps
Script, into `--print-columns`, and into the manifest, and
`import_evaluation_responses.py` imports that function rather than re-implementing
the format. Three consumers, one string.

Why set equality and not a count, at the seed-side gate: copied from
`seed_bundles.py:17-18`. A map covering 18 items that lists one twice has 19 rows,
and a count passes it. That is the case the gate exists for.

Why an ORDERED comparison at the header-side gate, and not set equality: duplicate
columns are precisely the failure to catch there, and a set swallows them
(SITE-00 finding 4). The two gates point in opposite directions on purpose.

Usage
-----
    # what the form will ask, and what the importer will see
    python3 scripts/build_evaluation_form.py --round w1 --print-columns
    python3 scripts/build_evaluation_form.py --round w1 --print-columns --json

    # the deliverable: a run-ready document plus its frozen column manifest
    python3 scripts/build_evaluation_form.py --round w1 \
        --out "$VAULT/.../Evaluation/Round-1-Form-AppsScript.md" \
        --allow-unsigned-session-map

    # is a delivered script still current against the contracts?
    python3 scripts/build_evaluation_form.py --check-digest <path>.md

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

DEFAULT_VAULT = Path(
    os.environ.get(
        "OBT_CDT_VAULT",
        str(Path.home() / "Documents/Josh & Katie Vault/Claude Can Access PARA"),
    )
)
EVAL_SUBDIR = "Projects/OBT/OBT Consultant Track/Psalms (Bali 2026)/Evaluation"
SESSION_MAP_NAME = "Session-Map.md"
QUESTION_SET_NAME = "Question-Set.md"

ROUNDS = ("w1", "w2")
ROUND_NUMBER = {"w1": 1, "w2": 2}
ROUND_WEEK_LABEL = {"w1": "week one", "w2": "the fortnight"}

# Session-Map.md's vocabularies. SITE-00 finding 5 added `fullday`, `workblock`
# and `ceremony` after the first draft's vocabularies failed to cover the schedule
# they are transcribed from.
PARTS = ("devotional", "morning", "afternoon", "fullday")
KINDS = ("devotional", "session", "practicum", "workblock", "ceremony")

# The word that goes inside an emitted column title. `fullday` is expanded because
# a participant reads this string and "fullday" reads as a typo.
PART_WORD = {
    "devotional": "devotional",
    "morning": "morning",
    "afternoon": "afternoon",
    "fullday": "full day",
}

# The key scheme. Morning items take -m1, -m2, -m3 ... by `ordinal` within a day.
FIXED_SUFFIX = {"devotional": "dev", "afternoon": "pm", "fullday": "fd"}

# Columns Google writes, which are not item titles. SITE-00 finding 3: the header
# row is NOT only item titles, and the importer skips these BY NAME, never by
# position.
RESERVED_COLUMNS = [
    {
        "title": "Timestamp",
        "presence": "always",
        "note": "Google writes it; always column A.",
    },
    {
        "title": "Email Address",
        "presence": "only when response-email collection is switched on",
        "note": (
            "The generated script does not switch it on, but a facilitator can, "
            "from the form's Settings. Skip by name so the position of every "
            "other column is irrelevant."
        ),
    },
]

# The optional identity field. Decision 4: naming yourself is optional, and the
# covering message states the trade. The importer must be able to represent a
# response with no participant rather than rejecting it.
NAME_COLUMN_KEY = "p-name"
NAME_COLUMN_TITLE = "Your name (optional)"

# The audience field, added 2026-08-26 when Joshua widened the round from CITs
# only to CITs, facilitators and ethnoarts specialists. It is required, and it is
# required because of SITE-00 finding 7: one anonymous sheet mixing a CIT's rating
# of a session with the rating given by the person who taught it produces an
# aggregate nobody can interpret. The groups and the prompt are read from
# Question-Set.md, never written here, per rubric row 4.
AUDIENCE_COLUMN_KEY = "p-group"

# Week 2 day 4 has no content decided (Workshop Plan §6.2, SITE-00 finding 6), so
# its row is provisional and a round-2 run refuses rather than quietly omitting a
# day of the workshop.
PROVISIONAL_KEY = "w2d4-m1"

COLUMN_MARKER = re.compile(r"^\s*// COLUMN (\d{3}) (\w+) (\S+)$")
SET_TITLE = re.compile(r"\.setTitle\('((?:[^'\\]|\\.)*)'\)")


class ContractError(Exception):
    """A refusal to read. Always names the file and, where there is one, the row."""


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _plain(value: str) -> str:
    """Strip the emphasis a human adds to a contract table for readability.

    `| **false** |` must read as `false`. Backticks likewise: the vocabularies are
    written `` `w1` `` in prose and bare in the tables, and a stray pair should not
    become a vocabulary violation.
    """
    v = value.strip()
    while len(v) > 4 and v.startswith("**") and v.endswith("**"):
        v = v[2:-2].strip()
    if len(v) > 2 and v.startswith("`") and v.endswith("`"):
        v = v[1:-1].strip()
    return v


def _flag(value: str, where: str, what: str) -> bool:
    v = _plain(value).lower()
    if v not in ("true", "false"):
        raise ContractError(f"{where}: {what} must be true or false, got {value!r}")
    return v == "true"


def _active(value: str, title: str, where: str) -> tuple[bool, bool]:
    """`active` accepts true, false, or `auto`.

    `auto` means "active if this row has a title", and it exists so Joshua can
    fill a blank row in from memory by typing the title and nothing else. The
    failure it removes is the two-step edit: before this, naming a devotional and
    forgetting to flip `active` left the row silently out of the form, and the
    only symptom was a shorter form. Explicit true or false still wins, so a row
    that is titled but deliberately not asked about stays possible.

    Returns (active, auto), so the count report can say which rows decided
    themselves rather than being told.
    """
    v = _plain(value).lower()
    if v == "auto":
        return bool(_plain(title)), True
    return _flag(value, where, "active"), False


def _int(value: str, where: str, what: str) -> int:
    v = _plain(value)
    if not re.fullmatch(r"-?\d+", v):
        raise ContractError(f"{where}: {what} must be an integer, got {value!r}")
    return int(v)


def _is_separator(cells: list[str]) -> bool:
    return all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c)


# --------------------------------------------------------------------------- #
# Session-Map.md
# --------------------------------------------------------------------------- #

ITEM_KEY = re.compile(r"w(\d)d(\d)-([a-z0-9]+)")


def parse_session_map(text: str, path: str) -> tuple[list[dict], dict]:
    """Rows and the file's own metadata: the sign-off and the per-round floors.

    Rows are read only inside a `## Week <n>` section, so the vocabulary and
    transcription tables elsewhere in the document cannot be mistaken for data.
    """
    signed = bool(re.search(r"^signed_off:\s*true\s*$", text, re.M))
    floors: dict[str, int] = {}
    for rnd in ROUNDS:
        m = re.search(rf"^min_items_{rnd}:\s*(\d+)\s*$", text, re.M)
        if not m:
            raise ContractError(
                f"{path}: the signed_off block is missing min_items_{rnd}. "
                "SITE-00 D3 requires a floor per round, so a map that "
                "accidentally deactivates everything cannot produce a "
                "two-question form that looks like success."
            )
        floors[rnd] = int(m.group(1))

    rows: list[dict] = []
    week: int | None = None
    for n, line in enumerate(text.split("\n"), start=1):
        heading = re.match(r"^## Week (\d)", line)
        if heading:
            week = int(heading.group(1))
            continue
        if line.startswith("## "):
            week = None
            continue
        s = line.strip()
        if week is None or not s.startswith("|"):
            continue
        cells = _cells(s)
        if _is_separator(cells) or _plain(cells[0]) == "item_key":
            continue
        if not ITEM_KEY.fullmatch(_plain(cells[0])):
            continue
        where = f"{path}:{n}"
        if len(cells) != 10:
            raise ContractError(
                f"{where}: an item row needs 10 columns "
                f"(item_key, round, day, part, kind, title, facilitator, ordinal, "
                f"active, note), found {len(cells)}"
            )
        part = _plain(cells[3])
        kind = _plain(cells[4])
        rnd = _plain(cells[1])
        if rnd not in ROUNDS:
            raise ContractError(
                f"{where}: round must be one of {', '.join(ROUNDS)}, got {rnd!r}"
            )
        if part not in PARTS:
            raise ContractError(
                f"{where}: part must be one of {', '.join(PARTS)}, got {part!r}"
            )
        if kind not in KINDS:
            raise ContractError(
                f"{where}: kind must be one of {', '.join(KINDS)}, got {kind!r}"
            )
        if ROUND_NUMBER[rnd] != week:
            raise ContractError(
                f"{where}: this row sits under '## Week {week}' but its round is "
                f"{rnd!r}. The section and the round column must agree, because "
                "`day` is per week and a mismatch shifts a whole week silently."
            )
        active, auto = _active(cells[8], cells[5], where)
        rows.append(
            {
                "typed_key": _plain(cells[0]),
                "round": rnd,
                "week": week,
                "day": _int(cells[2], where, "day"),
                "part": part,
                "kind": kind,
                "title": _plain(cells[5]),
                "facilitator": _plain(cells[6]),
                "ordinal": _int(cells[7], where, "ordinal"),
                "active": active,
                "auto": auto,
                "note": _plain(cells[9]),
                "where": where,
            }
        )
    if not rows:
        raise ContractError(
            f"{path}: no item rows found under any '## Week <n>' heading. "
            "Either the tables moved out of their sections or the file is not the "
            "session map."
        )
    return rows, {"signed_off": signed, "floors": floors}


def derive_keys(rows: list[dict], path: str) -> None:
    """Generate `item_key` and refuse when the typed column disagrees.

    D1 says `item_key` is generated and never typed. It is nonetheless written in
    the map so a human can read a row, so the honest reading is: derive it, then
    assert the typed column equals the derivation. That catches a transcription
    slip, which is the failure the rule is about.
    """
    morning: dict[tuple[int, int], list[dict]] = {}
    for r in rows:
        if r["part"] == "morning":
            morning.setdefault((r["week"], r["day"]), []).append(r)
    for group in morning.values():
        group.sort(key=lambda r: (r["ordinal"], r["typed_key"]))
        for i, r in enumerate(group, start=1):
            r["m_index"] = i

    seen: dict[str, dict] = {}
    for r in rows:
        if r["part"] == "morning":
            suffix = f"m{r['m_index']}"
        else:
            suffix = FIXED_SUFFIX[r["part"]]
        derived = f"w{r['week']}d{r['day']}-{suffix}"
        if derived != r["typed_key"]:
            raise ContractError(
                f"{r['where']}: item_key is derived, not typed. This row's "
                f"week {r['week']}, day {r['day']}, part {r['part']} and ordinal "
                f"{r['ordinal']} derive {derived!r}, but the row says "
                f"{r['typed_key']!r}."
            )
        if derived in seen:
            raise ContractError(
                f"{r['where']}: duplicate item_key {derived!r}, already used at "
                f"{seen[derived]['where']}. A duplicate key collapses two items "
                "into one row in the database and nothing downstream can tell."
            )
        seen[derived] = r
        r["item_key"] = derived


# --------------------------------------------------------------------------- #
# Question-Set.md
# --------------------------------------------------------------------------- #

QUESTION_KEY = re.compile(r"q-[a-z0-9-]+")


def parse_question_set(text: str, path: str) -> dict:
    scale: list[dict] = []
    prompts: dict[str, str] = {}
    questions: list[dict] = []
    sentence_lines: list[str] = []
    audience_lines: list[str] = []
    groups: list[dict] = []
    section = None

    for n, line in enumerate(text.split("\n"), start=1):
        if line.startswith("## "):
            h = line[3:].strip()
            if h.startswith("The scale"):
                section = "scale"
            elif h.startswith("The sentence"):
                section = "sentence"
            elif h.startswith("The comment prompt"):
                section = "prompts"
            elif h.startswith("Who is answering"):
                section = "audience"
            elif h.startswith("Round "):
                section = "questions"
            else:
                section = None
            continue
        where = f"{path}:{n}"
        if section == "sentence":
            if line.startswith(">"):
                sentence_lines.append(line.lstrip("> ").rstrip())
            continue
        if section == "audience" and line.startswith(">"):
            audience_lines.append(line.lstrip("> ").rstrip())
            continue
        s = line.strip()
        if section is None or not s.startswith("|"):
            continue
        cells = _cells(s)
        if _is_separator(cells):
            continue
        head = _plain(cells[0])

        if section == "scale":
            if head in ("choice string", ""):
                continue
            if len(cells) != 3:
                raise ContractError(
                    f"{where}: a scale row needs 3 columns "
                    f"(choice string, rating, attended), found {len(cells)}"
                )
            raw_rating = _plain(cells[1]).strip("*")
            if raw_rating.lower() in ("null", "none", ""):
                rating = None
            else:
                rating = _int(raw_rating, where, "rating")
            scale.append(
                {
                    "choice": head,
                    "rating": rating,
                    "attended": _flag(cells[2], where, "attended"),
                }
            )
        elif section == "prompts":
            if head in ("kind", ""):
                continue
            if len(cells) != 2:
                raise ContractError(
                    f"{where}: a comment-prompt row needs 2 columns "
                    f"(kind, prompt), found {len(cells)}"
                )
            if head not in KINDS:
                raise ContractError(
                    f"{where}: comment-prompt kind must be one of "
                    f"{', '.join(KINDS)}, got {head!r}"
                )
            prompts[head] = _plain(cells[1])
        elif section == "audience":
            if head in ("group_key", ""):
                continue
            if len(cells) != 2:
                raise ContractError(
                    f"{where}: an audience row needs 2 columns "
                    f"(group_key, label), found {len(cells)}"
                )
            if not re.fullmatch(r"[a-z][a-z0-9-]*", head):
                raise ContractError(
                    f"{where}: group_key must be lower-case kebab, got {head!r}"
                )
            label = _plain(cells[1])
            if not label:
                raise ContractError(f"{where}: audience group {head!r} has no label")
            groups.append({"group_key": head, "label": label, "where": where})
        elif section == "questions":
            if not QUESTION_KEY.fullmatch(head):
                continue
            if len(cells) != 6:
                raise ContractError(
                    f"{where}: a question row needs 6 columns (question_key, "
                    f"round, ordinal, kind, required, prompt), found {len(cells)}"
                )
            rnd = _plain(cells[1])
            if rnd not in ROUNDS + ("both",):
                raise ContractError(
                    f"{where}: question round must be w1, w2 or both, got {rnd!r}"
                )
            kind = _plain(cells[3])
            if kind not in ("long_text", "short_text", "choice"):
                raise ContractError(
                    f"{where}: question kind must be long_text, short_text or "
                    f"choice, got {kind!r}"
                )
            prompt = _plain(cells[5])
            if not prompt:
                raise ContractError(f"{where}: question {head!r} has no prompt")
            questions.append(
                {
                    "question_key": head,
                    "round": rnd,
                    "ordinal": _int(cells[2], where, "ordinal"),
                    "kind": kind,
                    "required": _flag(cells[4], where, "required"),
                    "prompt": prompt,
                    "where": where,
                }
            )

    missing = [k for k in KINDS if k not in prompts]
    if missing:
        raise ContractError(
            f"{path}: no comment prompt for kind(s) {', '.join(missing)}. Every "
            "kind in Session-Map's vocabulary needs one, because the prompt is "
            "chosen by kind and a missing one would silently drop the box."
        )
    if not scale:
        raise ContractError(f"{path}: the scale table is empty or was not found")
    if not any(s["rating"] is None for s in scale):
        raise ContractError(
            f"{path}: the scale has no absence option. 'I wasn't there' must exist "
            "and must map to a null rating, never to a zero."
        )
    if not questions:
        raise ContractError(f"{path}: no question rows found")
    if not sentence_lines:
        raise ContractError(
            f"{path}: the block quote under '## The sentence...' is missing. It is "
            "what makes the scale mean one thing and it is rendered to the "
            "participant, not stored."
        )
    if len(groups) < 2:
        raise ContractError(
            f"{path}: '## Who is answering' needs at least two audience groups, "
            f"found {len(groups)}. The round is answered by CITs, facilitators and "
            "ethnoarts specialists, and without this column a facilitator's rating "
            "of their own session is averaged in with the CITs' and nobody can see "
            "it happening (SITE-00 finding 7)."
        )
    seen_groups: dict[str, dict] = {}
    for g in groups:
        if g["group_key"] in seen_groups:
            raise ContractError(
                f"{g['where']}: group_key {g['group_key']!r} is already defined at "
                f"{seen_groups[g['group_key']]['where']}"
            )
        if g["label"] in {x["label"] for x in seen_groups.values()}:
            raise ContractError(
                f"{g['where']}: two audience groups carry the label {g['label']!r}. "
                "The label is what arrives in the export, so duplicates cannot be "
                "told apart."
            )
        seen_groups[g["group_key"]] = g
    if not audience_lines:
        raise ContractError(
            f"{path}: '## Who is answering' has no block-quote prompt. The question "
            "text is a contract like every other on-screen string, and a literal in "
            "the script would put it outside the digest."
        )
    return {
        "scale": scale,
        "prompts": prompts,
        "questions": questions,
        "sentence": " ".join(x for x in sentence_lines if x),
        "audience": {
            "prompt": " ".join(x for x in audience_lines if x),
            "groups": groups,
        },
    }


# --------------------------------------------------------------------------- #
# The single author of a column title
# --------------------------------------------------------------------------- #


def emitted_title(row: dict) -> str:
    """`Week <w>, Day <d> <part>: <title>`.

    The week, the day and the part live inside the string so that two items whose
    titles genuinely match cannot produce two identically named columns, which is
    a known Google data-loss case rather than a theoretical one (finding 2).

    `import_evaluation_responses.py` imports THIS function. A second
    implementation of this format is the two-code-systems failure.
    """
    return (
        f"Week {row['week']}, Day {row['day']} {PART_WORD[row['part']]}: "
        f"{row['title']}"
    )


def comment_title(row: dict) -> str:
    """The comment box beside an item needs its own column, so its own title.

    `(comments)` and not `[comments]`: a square-bracket suffix is Google's own
    grid-row convention (finding 3) and reusing it would make a plain column look
    like a grid column to the importer.
    """
    return f"{emitted_title(row)} (comments)"


def build_columns(rows: list[dict], qs: dict, rnd: str) -> list[dict]:
    """The ordered column list: what the form asks, in the order it asks it."""
    active = sorted(
        (r for r in rows if r["round"] == rnd and r["active"]),
        key=lambda r: (r["day"], r["ordinal"], r["item_key"]),
    )
    questions = sorted(
        (q for q in qs["questions"] if q["round"] in (rnd, "both")),
        key=lambda q: (q["ordinal"], q["question_key"]),
    )

    columns: list[dict] = [
        {
            "column_kind": "identity",
            "key": NAME_COLUMN_KEY,
            "title": NAME_COLUMN_TITLE,
            "item_type": "text",
            "required": False,
        },
        {
            "column_kind": "audience",
            "key": AUDIENCE_COLUMN_KEY,
            "title": qs["audience"]["prompt"],
            "item_type": "multiple_choice",
            "required": True,
            "choices": [g["label"] for g in qs["audience"]["groups"]],
            "group_keys": [g["group_key"] for g in qs["audience"]["groups"]],
        },
    ]
    for r in active:
        columns.append(
            {
                "column_kind": "rating",
                "key": r["item_key"],
                "title": emitted_title(r),
                "item_type": "multiple_choice",
                "required": True,
                "day": r["day"],
                "part": r["part"],
                "kind": r["kind"],
                "facilitator": r["facilitator"],
            }
        )
        columns.append(
            {
                "column_kind": "comment",
                "key": r["item_key"],
                "title": comment_title(r),
                "item_type": "paragraph",
                "required": False,
                "day": r["day"],
                "kind": r["kind"],
                "prompt": qs["prompts"][r["kind"]],
            }
        )
    for q in questions:
        columns.append(
            {
                "column_kind": "question",
                "key": q["question_key"],
                "title": q["prompt"],
                "item_type": {
                    "long_text": "paragraph",
                    "short_text": "text",
                    "choice": "multiple_choice",
                }[q["kind"]],
                "required": q["required"],
                "question_kind": q["kind"],
            }
        )

    seen: dict[str, dict] = {}
    for i, c in enumerate(columns, start=1):
        c["position"] = i
        if c["title"] in seen:
            other = seen[c["title"]]
            raise ContractError(
                f"duplicate emitted title {c['title']!r}: column "
                f"{other['position']} ({other['column_kind']} {other['key']}) and "
                f"column {i} ({c['column_kind']} {c['key']}) would produce two "
                "identically named spreadsheet columns, and Google will not keep "
                "them apart. Change a title in the contract, or the title format."
            )
        for res in RESERVED_COLUMNS:
            if c["title"] == res["title"]:
                raise ContractError(
                    f"column {i} ({c['column_kind']} {c['key']}) is titled "
                    f"{c['title']!r}, which is a reserved column Google writes "
                    "itself. The importer skips reserved columns by name, so this "
                    "item's answers would be silently discarded."
                )
        seen[c["title"]] = c
    return columns


# --------------------------------------------------------------------------- #
# The Apps Script
# --------------------------------------------------------------------------- #


def js(value: str) -> str:
    out = value.replace("\\", "\\\\").replace("'", "\\'")
    out = out.replace("\r", "").replace("\n", "\\n")
    return f"'{out}'"


def form_title(rnd: str) -> str:
    return (
        "Bali 2026 Psalms workshop: "
        + ("week one evaluation" if rnd == "w1" else "end-of-course evaluation")
    )


def form_description(rnd: str, qs: dict, columns: list[dict]) -> str:
    ratings = sum(1 for c in columns if c["column_kind"] == "rating")
    comments = sum(1 for c in columns if c["column_kind"] == "comment")
    questions = sum(1 for c in columns if c["column_kind"] == "question")
    scope = ROUND_WEEK_LABEL[rnd]
    return "\n\n".join(
        [
            f"This is your evaluation of {scope}. It shapes what we change, and "
            "for the sessions we teach again it shapes them directly.",
            qs["sentence"],
            "If you were not in a session, choose \"I wasn't there\". That is a "
            "real answer and it is better than a guess: a guessed rating moves "
            "the average and nobody can see it happening.",
            f"There are {ratings} things to rate, a comment box beside each one "
            f"that you can leave empty, and {questions} questions at the end. "
            f"({comments} comment boxes, all optional.) The comments are the part "
            "we read most closely.",
            "We are asking the consultants in training, the facilitators and the "
            "ethnoarts specialists, so the second question asks which of those you "
            "are. It is the one question you have to answer. Ratings are read per "
            "group, because a facilitator rating a session they taught and a CIT "
            "rating the same session are not the same measurement, and averaging "
            "them together would hide that.",
            "What happens to what you write, plainly. These answers land in a "
            "spreadsheet in Josh's Google Drive. Josh reads them, and Josh is one "
            "of the people you are rating. Nobody else sees the raw responses. "
            "Naming yourself is optional: what it buys is that your answers can "
            "follow you into the OBT-CDT member portal later, and that we can tell "
            "your week-two answers from your week-one ones. What it costs is that "
            "Josh sees your name against your answers. That is a real trade and it "
            "is yours to make.",
        ]
    )


def confirmation_message(rnd: str) -> str:
    if rnd == "w1":
        return (
            "Thank you. That is genuinely useful, and the parts you wrote out are "
            "the parts we will act on first. Anything you said about a session we "
            "teach again next week, we will have read before we teach it."
        )
    return (
        "Thank you. That is the last thing we will ask of you here, and it is the "
        "one that shapes the next workshop most. Go and rest, and travel safely."
    )


def render_appsscript(
    rnd: str,
    columns: list[dict],
    qs: dict,
    digest: str,
    generated_from: dict,
    skipped: list[dict],
    overrides: list[str],
) -> str:
    choices = [s["choice"] for s in qs["scale"]]
    rating_choices = choices
    overall_choices = [s["choice"] for s in qs["scale"] if s["rating"] is not None]
    fn = f"createPsalmsEvaluationForm{ROUND_NUMBER[rnd]}"
    sheet = (
        f"Bali 2026 Psalms - {'Week 1' if rnd == 'w1' else 'End of course'} "
        "Evaluation Responses"
    )

    L: list[str] = []
    a = L.append
    a("/**")
    a(f" * Bali 2026 Psalms workshop evaluation, round {rnd}.")
    a(" *")
    a(" * GENERATED by scripts/build_evaluation_form.py in obt-cdt-site. Do not")
    a(" * edit this file or the form's questions by hand: the column titles are")
    a(" * the importer's only key, and an edit here is reverted at the next run")
    a(" * while the September import silently loses that column.")
    a(" *")
    a(f" * source_digest: {digest}")
    for name, d in sorted(generated_from.items()):
        a(f" *   {name}: {d}")
    if overrides:
        a(" *")
        a(" * REFUSALS OVERRIDDEN AT GENERATION: " + ", ".join(overrides))
    if skipped:
        a(" *")
        a(" * Skipped as inactive: " + ", ".join(s["typed_key"] for s in skipped))
    a(" */")
    a(f"function {fn}() {{")
    a(f"  var SCALE = {json.dumps(rating_choices, ensure_ascii=False)};")
    a(f"  var OVERALL = {json.dumps(overall_choices, ensure_ascii=False)};")
    a(
        f"  var GROUPS = "
        f"{json.dumps([g['label'] for g in qs['audience']['groups']], ensure_ascii=False)};"
    )
    a("")
    a(f"  var form = FormApp.create({js(form_title(rnd))});")
    a(f"  form.setTitle({js(form_title(rnd))});")
    a(f"  form.setDescription({js(form_description(rnd, qs, columns))});")
    a("  form.setProgressBar(true);")
    a("  form.setAllowResponseEdits(true);")
    a("  form.setAcceptingResponses(true);")
    a("")

    day: int | None = None
    in_questions = False
    for c in columns:
        if c["column_kind"] == "identity":
            a(f"  // COLUMN {c['position']:03d} identity {c['key']}")
            a("  form.addTextItem()")
            a(f"    .setTitle({js(c['title'])})")
            a(
                "    .setHelpText("
                + js(
                    "Optional. Give your name if you would like these answers to "
                    "follow you into the member portal later, and to be told apart "
                    "from your other round's answers. Leave it blank to answer "
                    "anonymously; either way your ratings count the same."
                )
                + ")"
            )
            a("    .setRequired(false);")
            a("")
            continue

        if c["column_kind"] == "audience":
            a(f"  // COLUMN {c['position']:03d} audience {c['key']}")
            a("  form.addMultipleChoiceItem()")
            a(f"    .setTitle({js(c['title'])})")
            a(
                "    .setHelpText("
                + js(
                    "Required. Ratings are read per group, so a facilitator's "
                    "rating of a session is never averaged in with the CITs'."
                )
                + ")"
            )
            a("    .setChoiceValues(GROUPS)")
            a("    .setRequired(true);")
            a("")
            continue

        if c["column_kind"] in ("rating", "comment"):
            if c["day"] != day:
                day = c["day"]
                a(
                    f"  form.addPageBreakItem().setTitle("
                    + js(f"Day {day}")
                    + ");"
                )
                a("")
            if c["column_kind"] == "rating":
                a(f"  // COLUMN {c['position']:03d} rating {c['key']}")
                a("  form.addMultipleChoiceItem()")
                a(f"    .setTitle({js(c['title'])})")
                if c["facilitator"]:
                    a(f"    .setHelpText({js('Led by ' + c['facilitator'] + '.')})")
                a("    .setChoiceValues(SCALE)")
                a("    .setRequired(true);")
            else:
                a(f"  // COLUMN {c['position']:03d} comment {c['key']}")
                a("  form.addParagraphTextItem()")
                a(f"    .setTitle({js(c['title'])})")
                a(f"    .setHelpText({js(c['prompt'])})")
                a("    .setRequired(false);")
            a("")
            continue

        if not in_questions:
            in_questions = True
            a(
                "  form.addPageBreakItem().setTitle("
                + js("Looking back over the whole of it")
                + ");"
            )
            a("")
        a(f"  // COLUMN {c['position']:03d} question {c['key']}")
        if c["item_type"] == "paragraph":
            a("  form.addParagraphTextItem()")
            a(f"    .setTitle({js(c['title'])})")
            a(f"    .setRequired({'true' if c['required'] else 'false'});")
        elif c["item_type"] == "text":
            a("  form.addTextItem()")
            a(f"    .setTitle({js(c['title'])})")
            a(f"    .setRequired({'true' if c['required'] else 'false'});")
        else:
            a("  form.addMultipleChoiceItem()")
            a(f"    .setTitle({js(c['title'])})")
            a("    .setChoiceValues(OVERALL)")
            a(f"    .setRequired({'true' if c['required'] else 'false'});")
        a("")

    a(f"  form.setConfirmationMessage({js(confirmation_message(rnd))});")
    a("")
    a("  // A Workspace domain policy can restrict a form to the organization,")
    a("  // which would silently lock out every participant who is not on an SIL")
    a("  // account, and several of this cohort are not. setRequireLogin is")
    a("  // DEPRECATED, so the Settings page is the control and this is only")
    a("  // corroboration: check it by hand after running this.")
    a("  try {")
    a("    form.setRequireLogin(false);")
    a("  } catch (e) {")
    a(
        "    Logger.log('Could not set requireLogin: ' + e.message + "
        "' (check Settings by hand)');"
    )
    a("  }")
    a("")
    a(f"  var ss = SpreadsheetApp.create({js(sheet)});")
    a("  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());")
    a("")
    a("  Logger.log('SEND THIS TO PARTICIPANTS: ' + form.getPublishedUrl());")
    a("  Logger.log('EDIT THE FORM:            ' + form.getEditUrl());")
    a("  Logger.log('RESPONSES SPREADSHEET:    ' + ss.getUrl());")
    a("  try {")
    a(
        "    Logger.log('SHORT LINK (for WhatsApp): ' + "
        "form.shortenFormUrl(form.getPublishedUrl()));"
    )
    a("  } catch (e) {")
    a("    Logger.log('No short link available: ' + e.message);")
    a("  }")
    a("}")
    return "\n".join(L) + "\n"


# --------------------------------------------------------------------------- #
# The gates
# --------------------------------------------------------------------------- #


def unescape_js(value: str) -> str:
    return (
        value.replace("\\n", "\n").replace("\\'", "'").replace("\\\\", "\\")
    )


def reextract(source: str) -> list[dict]:
    """Read the columns back out of the RENDERED script.

    This is what makes the gates real rather than a tautology. The expected side
    comes from the parsed contracts; this side comes from the text that will
    actually be pasted into Apps Script. A count comparison whose two sides derive
    from one expression moves together and cannot detect the thing it exists to
    find, which is SITE-01's review finding and the reason this function exists.
    """
    out: list[dict] = []
    lines = source.split("\n")
    for i, line in enumerate(lines):
        m = COLUMN_MARKER.match(line)
        if not m:
            continue
        title = None
        for probe in lines[i + 1 : i + 8]:
            t = SET_TITLE.search(probe)
            if t:
                title = unescape_js(t.group(1))
                break
        if title is None:
            raise ContractError(
                f"the rendered script has a COLUMN marker at line {i + 1} with no "
                "setTitle after it. The generator is broken, not the contract."
            )
        out.append(
            {
                "position": int(m.group(1)),
                "column_kind": m.group(2),
                "key": m.group(3),
                "title": title,
            }
        )
    return out


def gate(columns: list[dict], source: str, rows: list[dict], rnd: str) -> list[str]:
    """Set equality on the item keys, ORDERED equality on the titles.

    The two directions are deliberate and opposite. Set equality on the seed side,
    per `seed_bundles.py:17-18`: a map that lists an item twice has one more row
    than items and a count passes it. Ordered equality on the header side, per
    SITE-00 finding 4: duplicate columns are the failure to catch there, and a set
    swallows them.
    """
    report: list[str] = []
    emitted = reextract(source)

    expected_keys = {r["item_key"] for r in rows if r["round"] == rnd and r["active"]}
    emitted_keys = {c["key"] for c in emitted if c["column_kind"] == "rating"}

    missing = sorted(expected_keys - emitted_keys)
    extra = sorted(emitted_keys - expected_keys)
    if missing or extra:
        detail = []
        if missing:
            detail.append(f"active in the map, never emitted: {', '.join(missing)}")
        if extra:
            detail.append(f"emitted, not active in the map: {', '.join(extra)}")
        raise ContractError(
            "the seed-side gate failed. " + "; ".join(detail) + ". A count would "
            "have passed at least one of these."
        )
    report.append(
        f"seed-side gate: set equality holds, {len(expected_keys)} active item(s) "
        "in the map and the same set emitted, both directions checked"
    )

    want = [(c["position"], c["title"]) for c in columns]
    got = [(c["position"], c["title"]) for c in emitted]
    if want != got:
        lines = ["the header-side gate failed, compared as an ordered list:"]
        for i in range(max(len(want), len(got))):
            w = want[i] if i < len(want) else None
            g = got[i] if i < len(got) else None
            if w != g:
                lines.append(f"  position {i + 1}: manifest {w!r} vs script {g!r}")
        raise ContractError("\n".join(lines))
    report.append(
        f"header-side gate: {len(got)} column(s) match as an ordered list "
        "including position"
    )
    return report


# --------------------------------------------------------------------------- #
# The manifest
# --------------------------------------------------------------------------- #


def manifest_for(
    rnd: str,
    columns: list[dict],
    qs: dict,
    digest: str,
    generated_from: dict,
    generated_on: str,
    overrides: list[str],
) -> dict:
    return {
        "round": rnd,
        "round_number": ROUND_NUMBER[rnd],
        "generated_on": generated_on,
        "generated_by": "scripts/build_evaluation_form.py",
        "source_digest": digest,
        "source_files": generated_from,
        "overrides_at_generation": overrides,
        "title_format": "Week <week>, Day <day> <part>: <title>",
        "comment_title_suffix": " (comments)",
        "reserved_columns": RESERVED_COLUMNS,
        "scale": qs["scale"],
        # The audience mapping is frozen here for the same reason the scale is: the
        # export carries the LABEL, and the importer needs the group_key. Without
        # this the September import would have to re-derive the mapping from
        # Question-Set.md as it then stands, which is the campaign-binding finding
        # about a document signed in August and read in September, applied to a
        # column instead of to an item.
        "audience": {
            "prompt": qs["audience"]["prompt"],
            "groups": [
                {"group_key": g["group_key"], "label": g["label"]}
                for g in qs["audience"]["groups"]
            ],
        },
        "columns": [
            {
                "position": c["position"],
                "column_kind": c["column_kind"],
                "item_key": c["key"] if c["column_kind"] in ("rating", "comment") else None,
                "question_key": c["key"] if c["column_kind"] == "question" else None,
                "participant_key": c["key"] if c["column_kind"] == "identity" else None,
                "title": c["title"],
                "required": c["required"],
            }
            for c in columns
        ],
    }


DELIVERY_DOC = """# {heading}

{intro}

Generated by `scripts/build_evaluation_form.py --round {rnd}` in `obt-cdt-site`,
on {generated_on}. **Do not edit the questions by hand**, in this file or in the
form. The column titles are the only key the September importer has, so an edit
here is reverted at the next run while the import quietly loses that column.
Change `Session-Map.md` or `Question-Set.md` and regenerate.

`source_digest: {digest}`

Its frozen column manifest is `{manifest_name}`, beside this file. That file is
the record of what the form actually **asked**, and it does not follow the map: the
map still has rows for Joshua to close on site, so by September it will have moved
and an importer re-deriving titles from it would fail to map every changed column.

{unsigned}## How to run it

1. Open [script.google.com](https://script.google.com) and click **New project**.
2. Select everything in the editor and paste the code below over it.
3. Click **Run**. Google will ask you to authorize the script; it is your own
   account creating your own form, so approve it.
4. Open the execution log at the bottom. It prints the form to send people, the
   form's edit URL, and the response spreadsheet.
5. **Then check Settings by hand.** `setRequireLogin(false)` is deprecated, so the
   Settings page is the real control: confirm responses are **not** restricted to
   SIL users, then open the published link signed out or from a non-SIL account and
   submit once. Several of this cohort are not on SIL accounts, and an absence-only
   check would report a clean sweep while they were silently excluded.
6. Send the published URL and the covering message together. The message is
   `Covering-Message.md` in this folder and it is not a formality: an evaluation
   sent with no explanation gets satisfaction-survey answers back.

## What it asks

{shape}

{skipped}

## The script

```javascript
{code}```

## Notes on the design

**Every rating is a multiple choice, not a scale item.** A Google Forms
`ScaleItem` carries labels on its two endpoints only, so a five-point worded scale
with a sixth non-numeric option is not a scale item at all. The consequence runs
downstream: every rating arrives in the export as a **string**, so the
label-to-integer mapping is a contract in `Question-Set.md` and in the manifest,
and the importer reads it rather than re-deriving it.

**No option is preselected**, because a form defaulting to "About average"
fabricates a rating for every item a participant scrolls past.

**"I wasn't there" maps to a null rating and never to a zero.** A zero sits inside
the 1-to-5 range's arithmetic and drags every mean toward the floor with nobody
able to see it happening.

**One page per day, plus a page for the closing questions.** A form this long
arriving as one scroll is a form people abandon halfway.

**The name field is optional and the description says what the trade is.** Without
a name an imported response can never attach to a person, so nothing can ever be
shown back to them; with one, Josh sees a name against answers about Josh. That is
a real trade and a participant is entitled to make it themselves.

**Duplicates are expected**, as on the meal form: response editing is on, so when
you read the counts take the latest row per name rather than counting rows.
"""


def render_delivery_doc(
    rnd: str,
    code: str,
    columns: list[dict],
    digest: str,
    generated_on: str,
    manifest_name: str,
    skipped: list[dict],
    overrides: list[str],
) -> str:
    ratings = sum(1 for c in columns if c["column_kind"] == "rating")
    comments = sum(1 for c in columns if c["column_kind"] == "comment")
    questions = sum(1 for c in columns if c["column_kind"] == "question")
    days = sorted({c["day"] for c in columns if c["column_kind"] == "rating"})

    if rnd == "w1":
        heading = "Round 1 evaluation form, end of week one (Apps Script)"
        intro = (
            "The week-one evaluation for the Bali 2026 Psalms workshop, built in "
            "one run: the form, its pages, every rating item, every comment box, "
            "the closing questions and a linked response spreadsheet. It runs on a "
            "Google Form because the member portal cannot be ready in time and the "
            "workshop will not wait. Nothing collected this way is lost: the "
            "schema is built to import it."
        )
    else:
        heading = "Round 2 evaluation form, end of course (Apps Script)"
        intro = (
            "The end-of-course evaluation for the Bali 2026 Psalms workshop. It is "
            "generated now and **run at the end of week two**, not before. It "
            "re-asks week one's four questions over the second week and adds the "
            "continuity questions, which are the ones this fortnight was designed "
            "to answer."
        )

    shape_lines = [
        f"An optional name field, then **{ratings} things to rate** across "
        f"{len(days)} day page(s), each with an optional comment box "
        f"({comments} in all), then **{questions} closing question(s)**. "
        f"{1 + ratings + comments + questions} inputs in total, of which "
        f"{sum(1 for c in columns if c['required'])} are required.",
        "",
        "| # | what | key | title |",
        "| --- | --- | --- | --- |",
    ]
    for c in columns:
        shape_lines.append(
            f"| {c['position']} | {c['column_kind']} | `{c['key']}` | {c['title']} |"
        )
    shape = "\n".join(shape_lines)

    if skipped:
        skipped_text = (
            "**Skipped as inactive, and reported rather than refused.** "
            + ", ".join(
                f"`{s['typed_key']}`"
                + (f" ({s['note']})" if s["note"] else "")
                for s in skipped
            )
            + " These rows exist so the map is complete and so filling one in "
            "later does not renumber the sessions beside it."
        )
    else:
        skipped_text = "Every row in this round's map is active. Nothing was skipped."

    unsigned = ""
    if "--allow-unsigned-session-map" in overrides:
        unsigned = (
            "## Read this first, because the map is not signed off yet\n\n"
            "Every session title below is transcribed from the Workshop Plan, which "
            "was last modified 2026-05-12. They are what was **scheduled**, not what "
            "was **delivered**. This document exists so that the review is an "
            "argument with a draft rather than with a blank page, which is the only "
            "way it fits into a Friday.\n\n"
            "So the order is: read the table under \"What it asks\", correct "
            "`Session-Map.md` where a title, a facilitator or a whole session is "
            "wrong, name any devotional that actually happened and set its row "
            "`active: true`, then set `signed_off: true` with your name and the "
            "date. Then regenerate and only then run it:\n\n"
            "```bash\n"
            "cd ~/Documents/GitHub/obt-cdt-site\n"
            "python3 scripts/build_evaluation_form.py --round " + rnd + " \\\n"
            "    --out \"$VAULT/.../Evaluation/" + f"Round-{ROUND_NUMBER[rnd]}"
            "-Form-AppsScript.md\" \\\n"
            "    --regenerate-manifest\n"
            "```\n\n"
            "`--regenerate-manifest` is needed because a manifest already exists "
            "from this generation, and overwriting one is refused by default. It is "
            "safe here and only here: the form has not been run, so no response "
            "depends on the old titles. After the form has been filled, that same "
            "refusal is the thing protecting the September import, so do not pass "
            "the flag again.\n\n"
            "If you have no time to correct the map, running this as it stands is "
            "still better than no evaluation. What it costs is that a participant "
            "may be asked to rate a session under a title they do not recognise, "
            "and will most likely answer \"I wasn't there\".\n\n"
        )

    if overrides:
        skipped_text += (
            "\n\n**Refusals overridden at generation: "
            + ", ".join(f"`{o}`" for o in overrides)
            + ".** Read each one before you run this. "
        )
        if "--allow-undecided-w2d4" in overrides:
            skipped_text += (
                "In particular, **week 2 day 4 is still undecided and is missing "
                "from this form**. Regenerate once Joshua has closed it, or the "
                "round-2 form asks about nine days of a ten-day workshop."
            )

    return DELIVERY_DOC.format(
        heading=heading,
        intro=intro,
        rnd=rnd,
        generated_on=generated_on,
        digest=digest,
        manifest_name=manifest_name,
        unsigned=unsigned,
        shape=shape,
        skipped=skipped_text,
        code=code,
    )


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #


def compute_digest(sources: dict[str, str]) -> tuple[str, dict[str, str]]:
    """One digest over both contracts, plus each file's own, for a readable header."""
    per_file = {}
    combined = hashlib.sha256()
    for name in sorted(sources):
        text = sources[name]
        per_file[name] = hashlib.sha256(text.encode()).hexdigest()[:16]
        combined.update(name.encode())
        combined.update(b"\0")
        combined.update(text.encode())
        combined.update(b"\0")
    return combined.hexdigest(), per_file


def print_columns(columns: list[dict], qs: dict, digest: str, rnd: str) -> None:
    print(f"# round {rnd}, {len(columns)} column(s), source_digest {digest}")
    print("#")
    print("# reserved columns, written by Google and skipped BY NAME:")
    for r in RESERVED_COLUMNS:
        print(f"#   {r['title']!r}\t{r['presence']}")
    print("#")
    print("# the scale is a contract: every rating arrives as a STRING")
    for s in qs["scale"]:
        rating = "null" if s["rating"] is None else s["rating"]
        print(f"#   {s['choice']!r}\t-> rating {rating}\tattended {s['attended']}")
    print("#")
    print("# position\tcolumn_kind\tkey\ttitle")
    for c in columns:
        print(f"{c['position']}\t{c['column_kind']}\t{c['key']}\t{c['title']}")


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--round", choices=ROUNDS, help="which round to generate")
    ap.add_argument("--vault", type=Path, default=DEFAULT_VAULT)
    ap.add_argument(
        "--session-map", type=Path, help="override the map's path, to gate a scratch copy"
    )
    ap.add_argument(
        "--question-set", type=Path, help="override the question set's path"
    )
    ap.add_argument(
        "--out",
        type=Path,
        help="write the Apps Script here. A .md path is wrapped in the delivery "
        "document; a .js path is the bare script. Either way the column manifest "
        "is written beside it.",
    )
    ap.add_argument(
        "--print-columns", action="store_true", help="what the importer will see"
    )
    ap.add_argument("--json", action="store_true", help="machine-readable --print-columns")
    ap.add_argument(
        "--check-digest",
        type=Path,
        help="read the source_digest out of a delivered document and compare it "
        "against a freshly computed one; exit 1 if the delivered script is stale",
    )
    ap.add_argument(
        "--generated-on",
        default=None,
        help="ISO date stamped into the artifacts; defaults to today",
    )
    ap.add_argument("--allow-unsigned-session-map", action="store_true")
    ap.add_argument(
        "--allow-short-round",
        action="store_true",
        help="emit fewer items than the map's min_items floor for this round",
    )
    ap.add_argument(
        "--allow-undecided-w2d4",
        action="store_true",
        help="generate round 2 while week 2 day 4 has no content decided",
    )
    ap.add_argument(
        "--list-blanks",
        action="store_true",
        help="list every map row that still has no title, with its key and its "
        "note, and say what filling it in would do. Reads the map and writes "
        "nothing, so it is safe to run at any time.",
    )
    ap.add_argument(
        "--regenerate-manifest",
        action="store_true",
        help="overwrite an existing column manifest whose digest differs. The "
        "manifest is the frozen record of what a form asked, so overwriting one "
        "after its form has been filled destroys the importer's only key.",
    )
    ap.add_argument(
        "--mutate-drop-emit",
        metavar="ITEM_KEY",
        help="HARNESS ONLY. Omit this item from the rendered script so the "
        "seed-side gate can be watched going red. Writes no files.",
    )
    ap.add_argument(
        "--mutate-extra-emit",
        metavar="ITEM_KEY",
        help="HARNESS ONLY. Render an extra rating item with no map row so the "
        "seed-side gate can be watched going red the other way. Writes no files.",
    )
    args = ap.parse_args()

    eval_dir = args.vault / EVAL_SUBDIR
    session_map = args.session_map or (eval_dir / SESSION_MAP_NAME)
    question_set = args.question_set or (eval_dir / QUESTION_SET_NAME)

    for path, what in ((session_map, "session map"), (question_set, "question set")):
        if not path.is_file():
            print(
                f"refused: {path} does not exist.\n"
                f"  The {what} is a contract document read by this script. Nothing "
                "is generated without it and no placeholder item is invented, "
                "because a placeholder item would be rateable.",
                file=sys.stderr,
            )
            return 1

    sources = {
        SESSION_MAP_NAME: session_map.read_text(encoding="utf-8"),
        QUESTION_SET_NAME: question_set.read_text(encoding="utf-8"),
    }
    digest, per_file = compute_digest(sources)

    if args.check_digest:
        if not args.check_digest.is_file():
            print(f"refused: {args.check_digest} does not exist", file=sys.stderr)
            return 1
        text = args.check_digest.read_text(encoding="utf-8")
        m = re.search(r"source_digest:\s*([0-9a-f]{64})", text)
        if not m:
            print(
                f"refused: {args.check_digest} carries no source_digest. A "
                "delivered script without one cannot be told from a stale one.",
                file=sys.stderr,
            )
            return 1
        delivered = m.group(1)
        print(f"delivered  {delivered}")
        print(f"contracts  {digest}")
        if delivered != digest:
            print(
                "\nSTALE. The contracts have changed since this script was "
                "generated. Regenerate it before running it, or the form will ask "
                "the old questions while the map promises the new ones.",
                file=sys.stderr,
            )
            return 1
        print("\ncurrent. The delivered script matches both contracts.")
        return 0

    if args.list_blanks:
        try:
            rows, _meta = parse_session_map(sources[SESSION_MAP_NAME], str(session_map))
            derive_keys(rows, str(session_map))
        except ContractError as e:
            print(f"refused: {e}", file=sys.stderr)
            return 1
        blanks = [r for r in rows if not r["title"]]
        print(f"{session_map}\n")
        if not blanks:
            print(
                f"No blank rows. All {len(rows)} rows carry a title, so nothing is "
                "waiting on anyone."
            )
            return 0
        print(
            f"{len(blanks)} of {len(rows)} rows still have no title. Type the title "
            "into the row's `title` cell and save; a row whose `active` reads `auto`\n"
            "activates itself, so there is no second edit to remember. Then re-run "
            "the generator for that round.\n"
        )
        for rnd_ in ROUNDS:
            mine = [r for r in blanks if r["round"] == rnd_]
            if not mine:
                continue
            print(f"  round {rnd_}")
            for r in sorted(mine, key=lambda r: (r["day"], r["ordinal"])):
                mode = "auto" if r["auto"] else ("true" if r["active"] else "false")
                print(
                    f"    {r['item_key']:<10} day {r['day']}  {r['kind']:<11} "
                    f"active={mode:<5} {r['note'] or ''}"
                )
            print()
        return 0

    if not args.round:
        ap.error(
            "--round is required unless you are using --check-digest or --list-blanks"
        )
    rnd = args.round

    try:
        rows, meta = parse_session_map(sources[SESSION_MAP_NAME], str(session_map))
        derive_keys(rows, str(session_map))
        qs = parse_question_set(sources[QUESTION_SET_NAME], str(question_set))
    except ContractError as e:
        print(f"refused: {e}", file=sys.stderr)
        return 1

    for r in rows:
        if r["active"] and not r["title"]:
            print(
                f"refused: {r['where']}: {r['item_key']} is active but has no "
                "title. An active row with no title emits a column named after "
                "nothing, and a participant is asked to rate a blank.",
                file=sys.stderr,
            )
            return 1

    overrides: list[str] = []
    if not meta["signed_off"]:
        if not args.allow_unsigned_session_map:
            print(
                f"refused: {session_map} is not signed off.\n"
                "  Week 1 is transcribed from a plan last modified 2026-05-12, "
                "not from what was delivered, so a facilitator on site has to "
                "confirm it first. Pass --allow-unsigned-session-map to generate a "
                "draft for Joshua to correct rather than argue about a blank page.",
                file=sys.stderr,
            )
            return 1
        overrides.append("--allow-unsigned-session-map")

    if rnd == "w2":
        prov = next((r for r in rows if r["item_key"] == PROVISIONAL_KEY), None)
        if prov is not None and not (prov["active"] and prov["title"]):
            if not args.allow_undecided_w2d4:
                print(
                    f"refused: {prov['where']}: {PROVISIONAL_KEY} has no content "
                    "decided, so a round-2 form would ask about nine days of a "
                    "ten-day workshop without saying so.\n"
                    "  Workshop Plan §6.2 still leaves three options open and one "
                    "of them produces more than one item, so the key scheme for "
                    "that day is provisional too. Close the day, or pass "
                    "--allow-undecided-w2d4 to generate a draft that says out loud "
                    "what is missing.",
                    file=sys.stderr,
                )
                return 1
            overrides.append("--allow-undecided-w2d4")

    try:
        columns = build_columns(rows, qs, rnd)
    except ContractError as e:
        print(f"refused: {e}", file=sys.stderr)
        return 1

    active = [r for r in rows if r["round"] == rnd and r["active"]]
    skipped = sorted(
        (r for r in rows if r["round"] == rnd and not r["active"]),
        key=lambda r: (r["day"], r["ordinal"]),
    )
    floor = meta["floors"][rnd]
    if len(active) < floor:
        if not args.allow_short_round:
            print(
                f"refused: round {rnd} emits {len(active)} item(s) but "
                f"{session_map.name} declares min_items_{rnd}: {floor}.\n"
                "  A map that accidentally deactivates its content produces a "
                "short form that looks like success, and the responses are gone "
                "before anyone counts. Fix the map, or pass --allow-short-round "
                "if the shortfall is deliberate and you have read it.",
                file=sys.stderr,
            )
            return 1
        overrides.append("--allow-short-round")

    mutating = bool(args.mutate_drop_emit or args.mutate_extra_emit)
    render_columns = columns
    if args.mutate_drop_emit:
        render_columns = [
            c for c in render_columns
            if not (c["column_kind"] == "rating" and c["key"] == args.mutate_drop_emit)
        ]
    if args.mutate_extra_emit:
        fake = dict(render_columns[1]) if len(render_columns) > 1 else dict(render_columns[0])
        fake.update(
            {
                "column_kind": "rating",
                "key": args.mutate_extra_emit,
                "title": f"Week 9, Day 9 morning: injected by --mutate-extra-emit",
                "item_type": "multiple_choice",
                "required": True,
                "day": 9,
                "part": "morning",
                "kind": "session",
                "facilitator": "",
                "position": len(render_columns) + 1,
            }
        )
        render_columns = render_columns + [fake]

    generated_on = args.generated_on or __import__("datetime").date.today().isoformat()
    code = render_appsscript(
        rnd, render_columns, qs, digest, per_file, skipped, overrides
    )

    if mutating:
        print(
            "MUTATION MODE. Files are not written. "
            f"drop={args.mutate_drop_emit!r} extra={args.mutate_extra_emit!r}\n"
        )

    print(f"session map   {session_map}")
    print(f"question set  {question_set}")
    print(f"round         {rnd}")
    print()
    print("counts, re-measured from the sources in this run")
    print(f"  rows in the map, all rounds   {len(rows):>4}")
    print(f"  rows in this round            {sum(1 for r in rows if r['round'] == rnd):>4}")
    print(f"  active, emitted               {len(active):>4}   floor {floor}")
    print(f"  inactive, skipped             {len(skipped):>4}")
    # Every column_kind that exists, not a hard-coded list, so the breakdown adds
    # up to the total. It stopped adding up the moment the audience column was
    # added, and a count report that does not reconcile is worse than none.
    kinds = ("identity", "audience", "rating", "comment", "question")
    unlisted = sorted({c["column_kind"] for c in columns} - set(kinds))
    for kind in kinds + tuple(unlisted):
        print(
            f"  columns, {kind:<20}{sum(1 for c in columns if c['column_kind'] == kind):>4}"
        )
    print(f"  columns, total                {len(columns):>4}")
    listed = sum(1 for c in columns if c["column_kind"] in set(kinds) | set(unlisted))
    if listed != len(columns):
        raise ContractError(
            f"the count report lists {listed} columns and there are {len(columns)}. "
            "A breakdown that does not reconcile with its own total is how a "
            "silently dropped column looks."
        )
    print(f"  required inputs               {sum(1 for c in columns if c['required']):>4}")
    by_day: dict[int, int] = {}
    for c in columns:
        if c["column_kind"] == "rating":
            by_day[c["day"]] = by_day.get(c["day"], 0) + 1
    print(f"  ratings per day             {by_day}")
    over_three = sorted(
        {
            (r["week"], r["day"])
            for r in rows
            if r["part"] == "morning" and r.get("m_index", 0) > 3
        }
    )
    if over_three:
        print(
            f"  NOTE: day(s) carrying more than three morning items, the key "
            f"sequence extends: {over_three}"
        )
    if skipped:
        print(
            "  skipped inactive: "
            + ", ".join(f"{s['typed_key']}" for s in skipped)
        )
    print(f"  source digest {digest[:16]}…")
    for name, d in sorted(per_file.items()):
        print(f"    {name:<20}{d}…")
    print(f"  {SESSION_MAP_NAME} signed off: " + ("YES" if meta["signed_off"] else "NO"))
    if overrides:
        print("  OVERRIDES IN FORCE: " + ", ".join(overrides))
    print()

    try:
        for line in gate(render_columns, code, rows, rnd):
            print(line)
    except ContractError as e:
        print(f"\nrefused: {e}", file=sys.stderr)
        return 1
    print()

    if args.print_columns:
        if args.json:
            print(
                json.dumps(
                    manifest_for(
                        rnd, columns, qs, digest, per_file, generated_on, overrides
                    ),
                    indent=2,
                    ensure_ascii=False,
                )
            )
        else:
            print_columns(columns, qs, digest, rnd)

    if mutating:
        print("mutation mode: nothing written.")
        return 0

    if args.out:
        manifest_name = f"Round-{ROUND_NUMBER[rnd]}-Columns.json"
        manifest_path = args.out.parent / manifest_name
        manifest = manifest_for(
            rnd, columns, qs, digest, per_file, generated_on, overrides
        )
        if manifest_path.is_file():
            existing = json.loads(manifest_path.read_text(encoding="utf-8"))
            if existing.get("source_digest") != digest and not args.regenerate_manifest:
                print(
                    f"refused: {manifest_path} already exists with a different "
                    f"digest.\n"
                    f"  on disk    {existing.get('source_digest', '?')[:16]}… "
                    f"generated {existing.get('generated_on')}\n"
                    f"  contracts  {digest[:16]}…\n"
                    "  The manifest is the frozen record of what the form actually "
                    "asked, and the importer maps against it. Overwriting one whose "
                    "form has already been filled destroys the only key those "
                    "responses have. Pass --regenerate-manifest if the form has not "
                    "been run yet.",
                    file=sys.stderr,
                )
                return 1

        if args.out.suffix == ".md":
            body = render_delivery_doc(
                rnd, code, columns, digest, generated_on, manifest_name, skipped,
                overrides,
            )
        elif args.out.suffix == ".js":
            body = code
        else:
            print(
                f"refused: --out must end in .md (the delivery document) or .js "
                f"(the bare script), got {args.out.suffix!r}",
                file=sys.stderr,
            )
            return 1
        args.out.write_text(body, encoding="utf-8")
        manifest_path.write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        print(f"wrote {args.out}")
        print(f"wrote {manifest_path}")

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ContractError as e:  # pragma: no cover - belt and braces
        print(f"refused: {e}", file=sys.stderr)
        sys.exit(1)
