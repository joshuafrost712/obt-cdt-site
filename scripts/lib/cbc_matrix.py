"""Parse the vault's CBC competency matrix, and refuse anything that has shifted.

Spec CDT-01. Shared by seed_competency_registry.py and import_self_assessment.py
so that "what a unit key is" has exactly one definition in this repo.

Three things about this module are load-bearing and easy to undo by accident.

**The file list is explicit, not a glob.** `Projects/cbc-competency/` also holds
`active-brief.md`, `cbc-matrix/_INSTRUCTIONS.md`, `progress.md` and `feedback.md`,
which describe a SUPERSEDED 22-competency scheme keyed C01 to C22. A seed that
globbed `**/*.md` would ingest them and produce a registry with the wrong id
shape, and it would look tidy. A future maintainer who "fixes" the list into a
pattern will seed the wrong registry and will not notice.

**The descriptor selector is stated, because it is the one that moves.** Bullets
between a `**Component descriptors:**` marker and the next line beginning `**`.
Counting every top-level bullet gives 298, because each of the 26 files repeats a
four-bullet Rating Scale block. Counting to the next `##` gives 194 today but 196
as soon as one Evidence field holds a bulleted list, which the campaign expects to
happen when Joshua fills in his ratings. Only the stated rule is stable.

**The parser stops at the rating marker and never resumes.** Rating, Evidence and
Gap are one person's assessment data. They are not registry content, and the seed
must be structurally unable to read them rather than merely not asked to.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

# Counts measured 2026-08-21 against Projects/cbc-competency/cbc-matrix/ and
# Intake Assessment/Instruments/Domain-Map.md. A count that has moved is a real event: the
# right response is a human reading the diff, not a session editing a constant.
EXPECTED = {
    "units": 41,
    "statements": 41,
    "categories": 26,
    "scale_points": 4,
    "descriptor_bullets": 194,
    "descriptor_blocks": 41,
    "domains": 6,
    "category_links": 27,
}

# Per-file descriptor counts, GC then BT in alphabetical filename order. The total
# alone is not enough: a parser that mis-associates a block with the neighbouring
# unit still sums to 194.
EXPECTED_GC_VECTOR = [5, 14, 19, 15, 16, 9, 18, 5, 17, 7]
EXPECTED_BT_VECTOR = [4, 2, 4, 6, 3, 6, 9, 7, 3, 2, 3, 3, 3, 4, 4, 6]

GC_FILES = [
    "CBC_GC_Adult_Education.md",
    "CBC_GC_Consulting_Process_Skills.md",
    "CBC_GC_Interpersonal_Skills.md",
    "CBC_GC_Language_and_Culture.md",
    "CBC_GC_Mentoring.md",
    "CBC_GC_Multicultural_Environment.md",
    "CBC_GC_Program_Design_and_Engagement.md",
    "CBC_GC_Relating_to_Other_Organizations.md",
    "CBC_GC_Scholarship_and_Documentation.md",
    "CBC_GC_Technology_for_Consulting.md",
]
BT_FILES = [
    "CBC_BT_Bible_Background.md",
    "CBC_BT_Biblical_Content.md",
    "CBC_BT_Biblical_Languages.md",
    "CBC_BT_Communication.md",
    "CBC_BT_Discourse.md",
    "CBC_BT_Exegesis.md",
    "CBC_BT_Guiding_Translation_Teams.md",
    "CBC_BT_Hermeneutics.md",
    "CBC_BT_Language_Structure.md",
    "CBC_BT_Modes_of_Communication.md",
    "CBC_BT_Partnering_Well.md",
    "CBC_BT_Sociolinguistics.md",
    "CBC_BT_Translation_Practice.md",
    "CBC_BT_Translation_Principles.md",
    "CBC_BT_Translation_Resources.md",
    "CBC_BT_Translation_Styles.md",
]
MASTER_FILE = "CBC_Master_Matrix.md"

# The three fields the parser must never read. Collection stops at the first of
# these and does not resume for that unit.
STOP_MARKERS = (
    "**Proposed Rating",
    "**Evidence",
    "**Gap",
)

DESCRIPTOR_MARKER = "**Component descriptors:**"
STATEMENT_MARKER = "**Competency Statement.**"
RATIONALE_MARKER = "**Rationale.**"


class MatrixError(Exception):
    """A refusal. Carries a message naming the file and, where known, the line."""


@dataclass
class Unit:
    unit_key: str
    ordinal: int
    category_key: str
    category_name: str
    track: str
    sub_area: str | None
    statement: str
    rationale: str | None = None
    descriptors: list[str] = field(default_factory=list)
    source_file: str = ""


@dataclass
class Registry:
    scale: list[tuple[int, str, str]]
    categories: list[dict]
    units: list[Unit]
    domains: list[dict]
    links: list[dict]
    source_digest: str
    domain_map_signed_off: bool
    counts: dict


def _read(path: Path) -> str:
    if not path.exists():
        raise MatrixError(f"missing source file: {path}")
    return path.read_text(encoding="utf-8")


def slug_for(filename: str) -> str:
    """gc-adult-education from CBC_GC_Adult_Education.md. Derived, never typed."""
    m = re.match(r"CBC_(GC|BT)_(.+)\.md$", filename)
    if not m:
        raise MatrixError(f"filename is not a sub-matrix name: {filename}")
    return f"{m.group(1).lower()}-" + m.group(2).lower().replace("_", "-")


def name_for(filename: str) -> str:
    m = re.match(r"CBC_(?:GC|BT)_(.+)\.md$", filename)
    return m.group(1).replace("_", " ")


def parse_scale(text: str, filename: str) -> list[tuple[int, str, str]]:
    """The four 0-3 definitions from a `## Rating Scale` block."""
    out: list[tuple[int, str, str]] = []
    inside = False
    for line in text.split("\n"):
        if line.startswith("## Rating Scale"):
            inside = True
            continue
        if inside and line.startswith("## "):
            break
        if inside and line.startswith("- "):
            body = line[2:].strip()
            # The shape in the matrix is: `**0** — None. No exposure or evidence.`
            # So: the digit, then a dash, then a short label, then a full stop,
            # then the definition. Label and definition are stored separately
            # because the CIT-facing ledger shows the label and the evaluator
            # guidance shows the definition.
            m = re.match(r"^\*\*(\d)\*\*\s*[—–-]*\s*(.*)$", body)
            if not m:
                raise MatrixError(
                    f"{filename}: rating-scale bullet not in the expected "
                    f"`**N** — Label. Definition` shape: {body[:80]!r}"
                )
            level, rest = int(m.group(1)), m.group(2).strip()
            if "." in rest:
                label, definition = rest.split(".", 1)
            else:
                label, definition = rest, ""
            out.append((level, label.strip(), definition.strip()))
    if not out:
        raise MatrixError(f"{filename}: no `## Rating Scale` block found")
    return out


def parse_master(text: str) -> list[dict]:
    """The 41 numbered rows, across TWO tables with different column counts.

    General Core has 7 columns (#, Category, Sub-area, Statement, Rating,
    Evidence, Gap); BT-Specific has 6 and no Sub-area. A single regex over both
    silently mis-columns one of them.
    """
    if "## BT-Specific Consulting Competencies" not in text:
        raise MatrixError(f"{MASTER_FILE}: the BT-Specific heading is missing")
    gc_text, bt_text = text.split("## BT-Specific Consulting Competencies", 1)

    def rows(part: str, ncol: int, track: str) -> list[dict]:
        out = []
        for i, line in enumerate(part.split("\n"), start=1):
            s = line.strip()
            if not s.startswith("|"):
                continue
            cells = [c.strip() for c in s.strip("|").split("|")]
            if len(cells) != ncol or not cells[0].isdigit():
                continue
            out.append(
                {
                    "ordinal": int(cells[0]),
                    "category_name": cells[1],
                    "sub_area": cells[2] if track == "gc" else None,
                    "statement": cells[3] if track == "gc" else cells[2],
                    "track": track,
                }
            )
        return out

    gc = rows(gc_text, 7, "gc")
    bt = rows(bt_text, 6, "bt")
    all_rows = gc + bt

    nums = [r["ordinal"] for r in all_rows]
    if sorted(nums) != list(range(1, len(nums) + 1)):
        missing = sorted(set(range(1, max(nums) + 1)) - set(nums))
        dupes = sorted({n for n in nums if nums.count(n) > 1})
        raise MatrixError(
            f"{MASTER_FILE}: numbering is not 1..{len(nums)} without gap or repeat. "
            f"missing={missing} repeated={dupes}"
        )
    return all_rows


def parse_sub_matrix(text: str, filename: str) -> list[dict]:
    """Units from one sub-matrix file: statement, rationale, descriptors.

    Never reads Rating, Evidence or Gap. Collection for a unit stops at the first
    STOP_MARKER and does not resume.
    """
    units: list[dict] = []
    cur: dict | None = None
    mode: str | None = None
    stopped = False

    for lineno, line in enumerate(text.split("\n"), start=1):
        if line.startswith("## Rating Scale"):
            mode = "scale"
            continue

        # A GC file opens each unit with `## Sub-area N: <name>`; a BT file with
        # `## Category: <name>`.
        m_sub = re.match(r"^## Sub-area\s+(\d+)\s*:\s*(.+)$", line)
        m_cat = re.match(r"^## Category\s*:\s*(.+)$", line)
        if m_sub or m_cat:
            if cur is not None:
                units.append(cur)
            cur = {
                "sub_area": m_sub.group(2).strip() if m_sub else None,
                "sub_ordinal": int(m_sub.group(1)) if m_sub else None,
                "category_from_heading": m_cat.group(1).strip() if m_cat else None,
                "statement": None,
                "rationale": None,
                "descriptors": [],
                "line": lineno,
            }
            mode = None
            stopped = False
            continue

        if line.startswith("## "):
            mode = None
            continue
        if cur is None:
            continue

        if any(line.startswith(s) for s in STOP_MARKERS):
            stopped = True
            mode = None
            continue
        if stopped:
            continue

        if line.startswith(STATEMENT_MARKER):
            cur["statement"] = line[len(STATEMENT_MARKER) :].strip()
            mode = "statement"
            continue
        if line.startswith(RATIONALE_MARKER):
            cur["rationale"] = line[len(RATIONALE_MARKER) :].strip()
            mode = "rationale"
            continue
        if line.startswith(DESCRIPTOR_MARKER):
            mode = "descriptors"
            continue

        # The stated selector: any line beginning `**` ends a descriptor block.
        if line.startswith("**"):
            mode = None
            continue

        if mode == "descriptors" and line.startswith("- "):
            cur["descriptors"].append(line[2:].strip())
        elif mode == "statement" and line.strip():
            cur["statement"] = (cur["statement"] + " " + line.strip()).strip()
        elif mode == "rationale" and line.strip():
            cur["rationale"] = (cur["rationale"] + " " + line.strip()).strip()

    if cur is not None:
        units.append(cur)

    for u in units:
        if not u["statement"]:
            raise MatrixError(
                f"{filename}:{u['line']}: unit has no `{STATEMENT_MARKER}` line"
            )
        if not u["descriptors"]:
            raise MatrixError(
                f"{filename}:{u['line']}: unit has a descriptor block with zero bullets"
            )
    return units


def parse_domain_map(text: str, path: str) -> tuple[list[dict], list[dict], bool]:
    """The six domains and the 27 category links from Domain-Map.md."""
    signed = bool(re.search(r"^signed_off:\s*true\s*$", text, re.M))

    domains: list[dict] = []
    links: list[dict] = []
    section = None
    for line in text.split("\n"):
        if line.startswith("## Domains"):
            section = "domains"
            continue
        if line.startswith("## Category links"):
            section = "links"
            continue
        if line.startswith("## "):
            section = None
            continue
        s = line.strip()
        if not s.startswith("|") or section is None:
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if section == "domains" and len(cells) == 3 and re.match(r"^M\d+$", cells[0]):
            domains.append(
                {"domain_key": cells[0], "name": cells[1], "ordinal": int(cells[2])}
            )
        elif section == "links" and len(cells) >= 4 and re.match(r"^(gc|bt)-", cells[0]):
            links.append(
                {
                    "category_key": cells[0],
                    "category_name": cells[1],
                    "domain_key": cells[2],
                    "is_primary": cells[3].lower() == "true",
                    "note": cells[5] if len(cells) > 5 else "",
                }
            )

    if not domains:
        raise MatrixError(f"{path}: no domain rows found under `## Domains`")
    if not links:
        raise MatrixError(f"{path}: no link rows found under `## Category links`")
    return domains, links, signed


def load(matrix_dir: Path, domain_map: Path) -> Registry:
    """Parse everything, gate everything, and return the registry or raise."""
    sub_files = GC_FILES + BT_FILES

    # --- read, with the digest taken over all 28 sources -------------------
    texts: dict[str, str] = {}
    for name in sub_files + [MASTER_FILE]:
        texts[name] = _read(matrix_dir / name)
    dm_text = _read(domain_map)

    digest = hashlib.sha256()
    for name in sorted(texts):
        digest.update(name.encode())
        digest.update(texts[name].encode())
    digest.update(b"Domain-Map.md")
    digest.update(dm_text.encode())
    source_digest = digest.hexdigest()

    # --- the scale, identical in all 27 ------------------------------------
    scale = parse_scale(texts[GC_FILES[0]], GC_FILES[0])
    for name in sub_files + [MASTER_FILE]:
        other = parse_scale(texts[name], name)
        if other != scale:
            raise MatrixError(
                f"{name}: the Rating Scale block differs from {GC_FILES[0]}'s. "
                "All 27 files must carry the same four definitions."
            )

    # --- master rows -------------------------------------------------------
    master_rows = parse_master(texts[MASTER_FILE])

    # --- sub-matrix units --------------------------------------------------
    per_file: dict[str, list[dict]] = {}
    for name in sub_files:
        per_file[name] = parse_sub_matrix(texts[name], name)

    gc_vector = [sum(len(u["descriptors"]) for u in per_file[n]) for n in GC_FILES]
    bt_vector = [sum(len(u["descriptors"]) for u in per_file[n]) for n in BT_FILES]

    # --- category list, keys derived from filenames ------------------------
    categories = []
    for i, name in enumerate(GC_FILES, start=1):
        categories.append(
            {
                "category_key": slug_for(name),
                "track": "gc",
                "name": name_for(name),
                "ordinal": i,
                "file": name,
            }
        )
    for i, name in enumerate(BT_FILES, start=1):
        categories.append(
            {
                "category_key": slug_for(name),
                "track": "bt",
                "name": name_for(name),
                "ordinal": i,
                "file": name,
            }
        )
    by_name = {c["name"]: c for c in categories}

    # --- per-category unit counts, checked BEFORE stitching ----------------
    #
    # This runs first on purpose. A renamed or deleted `## Sub-area` heading
    # changes how many units a file defines, and if you discover that during
    # stitching the symptom is "statement does not match the master" for some
    # unrelated-looking unit further down. That message is true and useless. The
    # cause is a heading, so the refusal should say heading.
    master_per_cat: dict[str, int] = {}
    for row in master_rows:
        cat = by_name.get(row["category_name"])
        if cat is None:
            raise MatrixError(
                f"{MASTER_FILE}: unit {row['ordinal']} has category "
                f"{row['category_name']!r}, which matches no sub-matrix filename. "
                f"Known: {sorted(by_name)}"
            )
        master_per_cat[cat["file"]] = master_per_cat.get(cat["file"], 0) + 1

    for name in sub_files:
        want = master_per_cat.get(name, 0)
        got = len(per_file[name])
        if want != got:
            heading = "## Sub-area N: <name>" if name in GC_FILES else "## Category: <name>"
            raise MatrixError(
                f"{name}: the master lists {want} unit(s) for this category but the "
                f"file defines {got}.\n"
                f"  A unit is opened by a `{heading}` heading, so this is almost "
                "always a heading that was renamed, deleted or added.\n"
                "  Fix the heading rather than the count: every downstream unit_key "
                "shifts if the file's unit order changes."
            )

    # --- stitch master rows to sub-matrix units ---------------------------
    units: list[Unit] = []
    consumed: dict[str, int] = {name: 0 for name in sub_files}
    for row in master_rows:
        cat = by_name.get(row["category_name"])
        if cat is None:
            raise MatrixError(
                f"{MASTER_FILE}: unit {row['ordinal']} has category "
                f"{row['category_name']!r}, which matches no sub-matrix filename. "
                f"Known: {sorted(by_name)}"
            )
        fname = cat["file"]
        idx = consumed[fname]
        file_units = per_file[fname]
        if idx >= len(file_units):
            raise MatrixError(
                f"{fname}: the master lists more units for category "
                f"{cat['name']!r} than this file defines "
                f"({len(file_units)}). A `## Sub-area` or `## Category` heading "
                "is probably missing or renamed."
            )
        su = file_units[idx]
        consumed[fname] += 1

        if su["statement"] != row["statement"]:
            raise MatrixError(
                f"unit U{row['ordinal']:02d} ({cat['name']}): the statement in "
                f"{fname} does not match {MASTER_FILE} verbatim.\n"
                f"  master: {row['statement'][:110]!r}\n"
                f"  sub   : {su['statement'][:110]!r}"
            )

        units.append(
            Unit(
                unit_key=f"U{row['ordinal']:02d}",
                ordinal=row["ordinal"],
                category_key=cat["category_key"],
                category_name=cat["name"],
                track=cat["track"],
                sub_area=row["sub_area"] or su["sub_area"],
                statement=su["statement"],
                rationale=su["rationale"],
                descriptors=list(su["descriptors"]),
                source_file=fname,
            )
        )

    for fname, n in consumed.items():
        if n != len(per_file[fname]):
            raise MatrixError(
                f"{fname}: defines {len(per_file[fname])} units but the master "
                f"references only {n} for that category. A heading count and the "
                "master's row count for this category disagree."
            )

    # --- the domain map ----------------------------------------------------
    domains, links, signed = parse_domain_map(dm_text, str(domain_map))
    known_keys = {c["category_key"] for c in categories}
    known_domains = {d["domain_key"] for d in domains}
    for l in links:
        if l["category_key"] not in known_keys:
            raise MatrixError(
                f"{domain_map}: link row names category {l['category_key']!r}, "
                "which is not one of the 26 derived from the sub-matrix filenames"
            )
        if l["domain_key"] not in known_domains:
            raise MatrixError(
                f"{domain_map}: link row names domain {l['domain_key']!r}, "
                f"which is not in the Domains table ({sorted(known_domains)})"
            )
    primaries: dict[str, int] = {}
    for l in links:
        if l["is_primary"]:
            primaries[l["category_key"]] = primaries.get(l["category_key"], 0) + 1
    for key in sorted(known_keys):
        n = primaries.get(key, 0)
        if n == 0:
            raise MatrixError(
                f"{domain_map}: category {key!r} has no primary domain. "
                "Exactly one primary per category is required; at-most-one is "
                "enforced by a partial unique index, at-least-one is checked here."
            )
        if n > 1:
            raise MatrixError(
                f"{domain_map}: category {key!r} has {n} primary domains"
            )

    # --- the gate ----------------------------------------------------------
    counts = {
        "units": len(units),
        "statements": sum(len(v) for v in per_file.values()),
        "categories": len(categories),
        "scale_points": len(scale),
        "descriptor_bullets": sum(len(u.descriptors) for u in units),
        "descriptor_blocks": sum(len(v) for v in per_file.values()),
        "domains": len(domains),
        "category_links": len(links),
    }
    for key, expected in EXPECTED.items():
        if counts[key] != expected:
            raise MatrixError(
                f"count gate: {key} is {counts[key]}, expected {expected}.\n"
                "  This is a real event, not a nuisance. Read the diff in the "
                "source files and decide deliberately; do NOT edit the constant "
                "in scripts/lib/cbc_matrix.py to make this pass."
            )
    if gc_vector != EXPECTED_GC_VECTOR:
        raise MatrixError(
            f"count gate: per-file GC descriptor vector is {gc_vector}, "
            f"expected {EXPECTED_GC_VECTOR}. The total can be right while blocks "
            "are associated with the wrong units, which is what this catches."
        )
    if bt_vector != EXPECTED_BT_VECTOR:
        raise MatrixError(
            f"count gate: per-file BT descriptor vector is {bt_vector}, "
            f"expected {EXPECTED_BT_VECTOR}."
        )

    primary_units = sum(
        1 for u in units if any(l["is_primary"] and l["category_key"] == u.category_key for l in links)
    )
    if primary_units != 41:
        raise MatrixError(
            f"invariant: units over primary links is {primary_units}, expected 41"
        )

    return Registry(
        scale=scale,
        categories=categories,
        units=units,
        domains=domains,
        links=links,
        source_digest=source_digest,
        domain_map_signed_off=signed,
        counts=counts,
    )


def display_counts(reg: Registry) -> tuple[dict, dict]:
    """(primary, displayed) units per domain. Two aggregations, never conflated."""
    per_cat: dict[str, int] = {}
    for u in reg.units:
        per_cat[u.category_key] = per_cat.get(u.category_key, 0) + 1
    primary: dict[str, int] = {d["domain_key"]: 0 for d in reg.domains}
    displayed: dict[str, int] = {d["domain_key"]: 0 for d in reg.domains}
    for l in reg.links:
        n = per_cat.get(l["category_key"], 0)
        displayed[l["domain_key"]] += n
        if l["is_primary"]:
            primary[l["domain_key"]] += n
    return primary, displayed
