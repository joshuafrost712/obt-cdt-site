#!/usr/bin/env python3
"""Turn the vault's Links-Register contract into the member document for /members/materials.

Spec SITE-04 D3. Follows `build_evaluation_form.py`'s shape deliberately: read a
contract document the workshop owns, digest it, refuse while it is unsigned,
print every row written and every row skipped, and write nothing on refusal.

    python3 scripts/build_links_register.py --print-rows
    python3 scripts/build_links_register.py --list-blanks
    python3 scripts/build_links_register.py --coverage
    python3 scripts/build_links_register.py --allow-unsigned-links-register \
        --reason "the decks are collected and the page is being built"

## Why the override needs a reason and SITE-00's did not

This register will be regenerated for years by whoever is nearest a laptop when a
deck moves. A bare `--allow-unsigned` becomes the normal way to run it inside two
cohorts, and then nobody knows which rows were ever reviewed. The flag name also
differs from SITE-06's on purpose: two generators reading two different contract
documents should not answer to the same word, or a session in a hurry runs the
wrong one and reports success.

## The three text slots, and what does not render

A `linkGrid` item has three text slots and this register has ten columns
(SITE-04 finding 14). The collapse is stated here rather than discovered:

    label  <- label
    body   <- what, then the owner sentence when the access word needs a person,
              then `where` and `cost`, joined with a middot, capped at BODY_CAP
    note   <- the badge string for the access word, and nothing else, because it
              renders in micro-caps at 0.75rem and anything longer reads as a bug

`session_key`, `checked_on` and the free-text `note` do NOT render. That is a
decision (D3) and its consequence is in D7: staleness is visible per page, from
the page's own checked-on line, and not per row.

## What this refuses, and there are thirteen

     1. an unknown `access` word
     2. an active row with neither `url` nor `ref`
     3. a row carrying both a `url` and a `ref`
     4. a `ref` that resolves to no node in site-content.json
     5. a duplicate `link_key`
     6. a duplicate url or ref across sections
     7. a `request-access` row with no `owner`
     8. a `session_key` matching no row in Session-Map.md
     9. an assembled body over BODY_CAP
    10. a missing or duplicated sentinel token
    11. a `link_key` or page node id already present anywhere in site-content.json
    12. a participant name from the roster, or a partner-org name from the stop list
    13. an item naming a do-not-route programme, or contrasting the track with
        another pathway

Refusals 12 and 13 read `content-rules.yml` in the VAULT and never copy it here.
A stop list naming the organisations we must not name in public would be a public
naming of them, which is SITE-04 finding 5's rule pointed at prose instead of at
URLs. Each of those gates prints the size of the population it checked, and the
run refuses when every one of them is empty, because a content gate with nothing
to match cannot be told apart from no gate at all.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CONTENT_JSON = REPO / "src/content/site-content.json"

DEFAULT_VAULT = Path(
    os.environ.get(
        "OBT_CDT_VAULT",
        str(Path.home() / "Documents/Josh & Katie Vault/Claude Can Access PARA"),
    )
)
HUB = "Projects/OBT/OBT-CDT Central Hub"
REGISTER = DEFAULT_VAULT / HUB / "Member Pages/Links-Register.md"
OUTPUT = DEFAULT_VAULT / HUB / "Member Pages/materials.md"
RULES = DEFAULT_VAULT / HUB / "content-rules.yml"
SESSION_MAP = (
    DEFAULT_VAULT
    / "Projects/OBT/OBT Consultant Track/Psalms (Bali 2026)/Evaluation/Session-Map.md"
)

SENTINEL_RE = re.compile(r"^mbr-[0-9a-f]{32}$")
NODE_ID_RE = re.compile(r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$")

# A linkGrid card's body is two or three lines of type at card width. Past this
# the card grows taller than its neighbours and the grid stops reading as a grid.
BODY_CAP = 260

# The access vocabulary. The badge string is the ON-SCREEN string and this table
# is the only place it exists, which is what criterion 3 asserts: nothing in
# src/ may carry one of these phrases as a literal.
ACCESS = {
    "open-link": {
        "badge": "Opens for anyone with the link",
        "drive": "anyone",
        "needs_owner": False,
    },
    "named-people": {
        "badge": "Shared to named people",
        "drive": "no-anyone",
        "needs_owner": False,
    },
    "request-access": {
        "badge": "Ask {owner} for access",
        "drive": "no-anyone",
        "needs_owner": True,
    },
    "sil-only": {
        "badge": "SIL accounts only",
        "drive": "domain",
        "needs_owner": False,
    },
    "app-account": {
        "badge": "Needs an account",
        "drive": None,
        "needs_owner": False,
    },
    "unchecked": {
        "badge": "Access not yet checked",
        "drive": None,
        "needs_owner": False,
    },
}


class BuildError(Exception):
    """A refusal. Printed and exited on; never worked around."""


@dataclass
class Row:
    section: str
    label: str
    what: str
    url: str = ""
    ref: str = ""
    access: str = "unchecked"
    owner: str = ""
    where: str = ""
    cost: str = ""
    session_key: str = ""
    note: str = ""
    active_raw: str = "auto"
    link_key: str = ""
    body: str = ""
    badge: str = ""
    line_no: int = 0

    @property
    def active(self) -> bool:
        raw = (self.active_raw or "auto").strip().lower()
        if raw == "auto":
            return bool(self.url or self.ref)
        if raw in ("true", "yes"):
            return True
        if raw in ("false", "no"):
            return False
        raise BuildError(
            f"row {self.label!r}: `active` is {self.active_raw!r}; it must be "
            "`auto`, `true` or `false`"
        )


@dataclass
class Register:
    path: Path
    meta: dict
    body: str
    rows: list[Row] = field(default_factory=list)

    @property
    def digest(self) -> str:
        return hashlib.sha256(self.path.read_bytes()).hexdigest()


# ---------------------------------------------------------------------------
# Reading the contract
# ---------------------------------------------------------------------------

def _yaml(text: str, where: str) -> dict:
    try:
        import yaml
    except ModuleNotFoundError as exc:  # pragma: no cover - environment
        raise BuildError(f"PyYAML is needed to read {where}") from exc
    data = yaml.safe_load(text) or {}
    if not isinstance(data, dict):
        raise BuildError(f"{where}: not a mapping")
    return data


def split_front_matter(path: Path) -> tuple[dict, str]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        raise BuildError(f"{path}: no front matter. The first line must be exactly ---")
    end = text.find("\n---\n", 3)
    if end == -1:
        raise BuildError(f"{path}: front matter is not closed by a --- line of its own")
    return _yaml(text[4:end], str(path)), text[end + 5:]


def parse_tables(body: str) -> list[tuple[str, list[dict], list[int]]]:
    """Every markdown table under a `##` heading, read BY HEADER NAME.

    Reading by name rather than by position is what lets the two tables carry
    different columns, and it is why adding a column to one of them later cannot
    silently shift another column's values one place to the left.
    """
    out: list[tuple[str, list[dict], list[int]]] = []
    heading = ""
    rows: list[dict] = []
    lines_at: list[int] = []
    header: list[str] | None = None
    for n, line in enumerate(body.split("\n"), start=1):
        m = re.match(r"^##\s+(.*)$", line)
        if m:
            if header and rows:
                out.append((heading, rows, lines_at))
            heading, header, rows, lines_at = m.group(1).strip(), None, [], []
            continue
        if not line.strip().startswith("|"):
            if header and rows:
                out.append((heading, rows, lines_at))
                header, rows, lines_at = None, [], []
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if header is None:
            header = [c.strip("`") for c in cells]
            continue
        if all(set(c) <= set("-: ") for c in cells):
            continue
        if len(cells) != len(header):
            raise BuildError(
                f"line {n}: this row has {len(cells)} cells and its header has "
                f"{len(header)}. Read by header name, so a short row is a typo "
                "rather than a default."
            )
        rows.append(dict(zip(header, cells)))
        lines_at.append(n)
    if header and rows:
        out.append((heading, rows, lines_at))
    return out


def slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s or "row"


def load_register(path: Path) -> Register:
    meta, body = split_front_matter(path)
    for required in ("target_route", "title", "sentinel"):
        if not meta.get(required):
            raise BuildError(f"{path}: front matter is missing `{required}:`")
    reg = Register(path=path, meta=meta, body=body)

    wanted = {"Teaching materials": "teaching", "Applications": "apps"}
    seen_sections: set[str] = set()
    for heading, table, lines_at in parse_tables(body):
        if heading not in wanted:
            continue
        seen_sections.add(heading)
        for raw, line_no in zip(table, lines_at):
            if not raw.get("label"):
                continue
            reg.rows.append(Row(
                section=wanted[heading],
                label=raw.get("label", ""),
                what=raw.get("what", ""),
                url=raw.get("url", ""),
                ref=raw.get("ref", ""),
                access=(raw.get("access") or "unchecked").strip(),
                owner=raw.get("owner", ""),
                where=raw.get("where", ""),
                cost=raw.get("cost", ""),
                session_key=raw.get("session_key", ""),
                note=raw.get("note", ""),
                active_raw=raw.get("active", "auto"),
                line_no=line_no,
            ))
    missing = set(wanted) - seen_sections
    if missing:
        raise BuildError(
            f"{path}: no table found under {', '.join(sorted(missing))}. "
            "The generator reads sections by heading, so a renamed heading is a "
            "silent empty register otherwise."
        )
    if not reg.rows:
        raise BuildError(f"{path}: parsed to zero rows. An empty register is not a register.")
    return reg


# ---------------------------------------------------------------------------
# What the site already holds
# ---------------------------------------------------------------------------

# Overridable so the refusal harness can point the two content checks at a
# scratch copy. A refusal that can only be triggered by editing the real content
# file is a refusal nobody ever tests.
CONTENT_OVERRIDE: Path | None = None


def content_nodes() -> dict[str, dict]:
    """Every node in site-content.json that carries an `id`, by id."""
    data = json.loads((CONTENT_OVERRIDE or CONTENT_JSON).read_text(encoding="utf-8"))
    out: dict[str, dict] = {}

    def walk(node):
        if isinstance(node, dict):
            if isinstance(node.get("id"), str):
                out[node["id"]] = node
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(data)
    return out


def session_keys(path: Path) -> set[str]:
    """`kind: session` item keys, read straight out of Session-Map.md.

    Read by header name for the same reason the register is, and filtered on the
    `kind` column rather than on row position, because the map carries five kinds
    across two tables and a positional read would silently include devotionals.
    """
    if not path.exists():
        raise BuildError(f"{path}: Session-Map.md is missing, so the session_key gate has nothing to check")
    keys: set[str] = set()
    header: list[str] | None = None
    for line in path.read_text(encoding="utf-8").split("\n"):
        if not line.strip().startswith("|"):
            header = None
            continue
        cells = [c.strip().strip("`") for c in line.strip().strip("|").split("|")]
        if header is None:
            header = cells
            continue
        if all(set(c) <= set("-: ") for c in cells):
            continue
        if len(cells) != len(header) or "item_key" not in header or "kind" not in header:
            continue
        row = dict(zip(header, cells))
        if row.get("kind") == "session" and row.get("item_key"):
            keys.add(row["item_key"])
    if not keys:
        raise BuildError(
            f"{path}: no `kind: session` rows found. The coverage gate would then "
            "compare against an empty set and pass on anything."
        )
    return keys


def load_rules(path: Path) -> dict:
    if not path.exists():
        raise BuildError(
            f"{path}: the content-rules file is missing. Refusals 12 and 13 read it, "
            "and a content gate that quietly skips itself when its rules file is "
            "absent is the defect class this campaign keeps finding."
        )
    return _yaml(path.read_text(encoding="utf-8"), str(path))


# ---------------------------------------------------------------------------
# The thirteen refusals
# ---------------------------------------------------------------------------

def content_gates(reg: Register, rules: dict) -> None:
    """Refusals 12 and 13, each printing the population it checked."""
    haystack = reg.body.lower()
    populations = {
        "roster names": [str(n) for n in (rules.get("roster_names") or [])],
        "partner-org stop list": [str(n) for n in (rules.get("partner_org_stop_list") or [])],
        "do-not-route programmes": [str(n) for n in (rules.get("do_not_route") or [])],
        "pathway-contrast wording": [str(n) for n in (rules.get("pathway_contrast") or [])],
    }
    total = 0
    for name, needles in populations.items():
        total += len(needles)
        state = f"{len(needles)} term(s)"
        if not needles:
            status = rules.get(
                {"roster names": "roster_status",
                 "partner-org stop list": "partner_org_status"}.get(name, ""), "")
            state = f"EMPTY{f' ({status})' if status else ''}"
        print(f"    content gate {name:<26} {state}")
    if total == 0:
        raise BuildError(
            "every content-gate population in content-rules.yml is empty, so none of "
            "these gates can fail. Fill at least one, or the run is asserting nothing."
        )
    for name, needles in populations.items():
        for needle in needles:
            if needle.lower() in haystack:
                raise BuildError(
                    f"{reg.path.name} carries {needle!r}, which is on the {name} list "
                    f"in content-rules.yml. This is a refusal and not a warning "
                    "because whoever wrote it had not been told the rule."
                )


def validate(reg: Register, rules: dict, strict_sessions: bool = True) -> None:
    nodes = content_nodes()
    sessions = session_keys(SESSION_MAP)

    sentinel = str(reg.meta["sentinel"]).strip()
    if not SENTINEL_RE.match(sentinel):
        raise BuildError(
            f"sentinel {sentinel!r} is not of the form mbr-<32 hex>. It has to be "
            "opaque: scripts/member-sentinels.json is published in a public repo, so "
            "a sentinel that is a sentence puts member prose there."
        )
    manifest = REPO / "scripts/member-sentinels.json"
    if manifest.exists():
        known = json.loads(manifest.read_text(encoding="utf-8"))
        for route, tok in (known.get("sentinels") or known).items():
            if tok == sentinel and route != reg.meta["target_route"]:
                raise BuildError(
                    f"sentinel {sentinel} is already claimed by {route}. Two documents "
                    "sharing a sentinel makes the gate unable to say which one leaked."
                )

    # The page node must EXIST and be a member page. The first draft of this check
    # refused when it existed, which is backwards: the seed's own refusal 1 is that
    # the route is not marked `access: "member"`, so a register generated against a
    # route with no PageDef produces a document nothing can ever seed.
    route = str(reg.meta["target_route"]).strip()
    page = next(
        (n for n in nodes.values() if n.get("route") == route and "access" in n), None
    )
    if page is None:
        raise BuildError(
            f"no PageDef in site-content.json has route {route!r}. Add it with "
            '`"access": "member"` and `"blocks": []` before generating; without it '
            "the seed refuses the document this would write."
        )
    if page.get("access") != "member":
        raise BuildError(
            f"the PageDef for {route!r} has access {page.get('access')!r}, not "
            "'member'. This register is member content and must not render publicly."
        )
    if page.get("blocks"):
        raise BuildError(
            f"the PageDef for {route!r} carries {len(page['blocks'])} block(s). "
            "SITE-03 D1 requires `blocks: []` on a member node, and its structural "
            "gate checks that first."
        )
    page_id_seed = slug(route.strip("/"))

    # The vocabulary table in the register is documentation, and documentation
    # that can disagree with the code is worse than none: the page would show one
    # badge while the contract promised another. So it is cross-checked here.
    documented = {}
    for heading, table, _ in parse_tables(reg.body):
        if heading.startswith("What the access column means"):
            for row in table:
                word = (row.get("Word") or "").strip("`")
                if word:
                    documented[word] = (row.get("Badge on screen") or "").strip()
    if documented:
        for word, spec in ACCESS.items():
            want = spec["badge"].replace("{owner}", "the owner")
            got = documented.get(word)
            if got is None:
                raise BuildError(
                    f"the register's vocabulary table does not document {word!r}"
                )
            if got != want:
                raise BuildError(
                    f"the register documents the {word!r} badge as {got!r} and the "
                    f"generator emits {want!r}. The table is what a reader trusts."
                )

    seen_keys: dict[str, str] = {}
    seen_targets: dict[str, str] = {}

    for row in reg.rows:
        if row.access not in ACCESS:
            raise BuildError(
                f"line {row.line_no}, row {row.label!r}: unknown access word "
                f"{row.access!r}. Known words: {', '.join(sorted(ACCESS))}"
            )
        spec = ACCESS[row.access]

        if row.url and row.ref:
            raise BuildError(
                f"line {row.line_no}, row {row.label!r}: carries both a `url` and a "
                "`ref`. One resource, one address, or the page can disagree with itself."
            )
        if row.active and not (row.url or row.ref):
            raise BuildError(
                f"line {row.line_no}, row {row.label!r}: is active and has neither a "
                "`url` nor a `ref`. Set `active: false` with a reason in `note`, or "
                "leave it on `auto` so it stays out until a link exists."
            )
        if row.ref and row.ref not in nodes:
            raise BuildError(
                f"line {row.line_no}, row {row.label!r}: `ref` {row.ref!r} resolves to "
                "no node in site-content.json. A ref that resolves to nothing renders "
                "as a card with no link."
            )
        if row.ref and not nodes[row.ref].get("href"):
            raise BuildError(
                f"line {row.line_no}, row {row.label!r}: node {row.ref!r} carries no "
                "`href`, so it cannot stand in for a link."
            )
        if spec["needs_owner"] and not row.owner:
            raise BuildError(
                f"line {row.line_no}, row {row.label!r}: access is {row.access!r} and "
                "there is no `owner`. The badge names a person, and the remedy for a "
                "closed link is a message to them rather than a code change."
            )
        if row.session_key and row.session_key not in sessions and strict_sessions:
            # Not raised under --coverage. D6's second set difference exists to
            # NAME a dangling session key, and a refusal here made that half of
            # the report unreachable: the run died before it could print. The
            # write path still refuses, because a register that seeds a dangling
            # key is wrong; the report's job is to say which row and why.
            raise BuildError(
                f"line {row.line_no}, row {row.label!r}: `session_key` "
                f"{row.session_key!r} matches no `kind: session` row in Session-Map.md"
            )

        key = f"{page_id_seed}.{slug(row.label)}"
        if not NODE_ID_RE.match(key):
            raise BuildError(
                f"line {row.line_no}, row {row.label!r}: generated link_key {key!r} is "
                "not a valid node id"
            )
        if key in seen_keys:
            raise BuildError(
                f"line {row.line_no}: link_key {key!r} is generated by both "
                f"{seen_keys[key]!r} and {row.label!r}. Two rows cannot share one id; "
                "the renderer keys its cards on it."
            )
        if key in nodes:
            raise BuildError(
                f"line {row.line_no}, row {row.label!r}: link_key {key!r} already "
                "exists in site-content.json"
            )
        seen_keys[key] = row.label
        row.link_key = key

        target = row.url or (f"ref:{row.ref}" if row.ref else "")
        if target and row.active:
            if target in seen_targets:
                raise BuildError(
                    f"line {row.line_no}: {target} is on both {seen_targets[target]!r} "
                    f"and {row.label!r}. One resource, one row."
                )
            seen_targets[target] = row.label

        row.badge = spec["badge"].format(owner=row.owner or "the owner")
        parts = [row.what.strip()]
        if spec["needs_owner"] and row.owner:
            parts.append(f"Ask {row.owner}.")
        if row.where.strip():
            parts.append(row.where.strip())
        if row.cost.strip():
            parts.append(row.cost.strip())
        row.body = " · ".join(p for p in parts if p)
        if len(row.body) > BODY_CAP:
            raise BuildError(
                f"line {row.line_no}, row {row.label!r}: the assembled body is "
                f"{len(row.body)} characters and the cap is {BODY_CAP}. Shorten "
                "`what`; the card is three lines of type, not a paragraph."
            )

    content_gates(reg, rules)


# ---------------------------------------------------------------------------
# Emitting the member document
# ---------------------------------------------------------------------------

# Every sentence the member document carries comes from the VAULT, under the
# register's `copy:` key. None of it lives here.
#
# This is SITE-03 finding 18's rule arriving against a generator instead of a
# harness, and the seed caught it in this build: the first version of this file
# held the page's paragraphs as Python constants, and `seed_member_pages.py`
# refused the document because two of its lines were already in a tracked file of
# a public repository. A generator that holds member prose at rest leaks it and
# then jams the seed that would have caught the leak.
#
# The page's four FRAMING sentences are a separate case and are deliberately
# public: they live as `portal.materials.*` nodes and are rendered by
# `memberIntros.tsx` (decision 6). They are not emitted into the document at all,
# because a sentence in two places is a sentence the seed will refuse.
REQUIRED_COPY = ("teaching_lead", "apps_lead", "pending")


def render_document(reg: Register, nodes: dict[str, dict]) -> str:
    route = str(reg.meta["target_route"]).strip()
    active = [r for r in reg.rows if r.active]
    lines = [
        "---",
        f"route: {route}",
        f"title: {reg.meta['title']}",
    ]
    # No `kicker:`. The public PageDef already carries one and MemberPage renders
    # both, which put "For enrolled participants" on the page twice. Seen in
    # criterion 4's screenshot, which is the reason that criterion photographs a
    # real card instead of asserting one exists.
    lines.append(f"sentinel: {reg.meta['sentinel']}")
    exempt = reg.meta.get("exempt") or []
    if exempt:
        lines.append("exempt:")
        for e in exempt:
            lines.append(f"  - line: {json.dumps(str(e['line']), ensure_ascii=False)}")
            lines.append(f"    reason: {json.dumps(str(e['reason']), ensure_ascii=False)}")
    else:
        lines.append("exempt: []")
    copy = reg.meta.get("copy") or {}
    missing = [k for k in REQUIRED_COPY if not str(copy.get(k, "")).strip()]
    if missing:
        raise BuildError(
            f"{reg.path.name}: front matter `copy:` is missing {', '.join(missing)}. "
            "Every sentence the member page carries lives in the vault; this "
            "generator holds none of them, because a generator in a public repo "
            "that holds member prose has already published it."
        )

    lines += [
        "---",
        "",
    ]

    section_titles = {
        "teaching": ("Teaching materials", "m01-teaching", "teaching_lead"),
        "apps": ("Applications", "m02-applications", "apps_lead"),
    }
    for section, (title, anchor, copy_key) in section_titles.items():
        rows = [r for r in active if r.section == section]
        if not rows:
            continue
        lines += [
            f"## {title}",
            "",
            f"id: {slug(route.strip('/'))}.{section}",
            "type: linkGrid",
            f"anchor: {anchor}",
            "",
            str(copy[copy_key]).strip(),
            "",
            "| id | label | body | note | href |",
            "| --- | --- | --- | --- | --- |",
        ]
        for r in rows:
            href = r.url or nodes[r.ref]["href"]
            cells = [r.link_key, r.label, r.body, r.badge, href]
            lines.append("| " + " | ".join(c.replace("|", "\\|") for c in cells) + " |")
        lines.append("")

    lines += [
        "## Not yet hosted",
        "",
        f"id: {slug(route.strip('/'))}.pending",
        "anchor: m03-pending",
        "",
        str(copy["pending"]).strip(),
        "",
        f"Access last checked {reg.meta.get('checked_on', 'not recorded')}. "
        f"Links gathered {reg.meta.get('gathered_on', 'not recorded')}. "
        f"Build reference {reg.digest[:16]}, gate token {reg.meta['sentinel']}.",
        "",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------

def print_rows(reg: Register) -> None:
    print(f"  {len(reg.rows)} row(s) in {reg.path.name}")
    for r in reg.rows:
        state = "active " if r.active else "skipped"
        target = r.url or (f"ref:{r.ref}" if r.ref else "(no link)")
        print(f"    {state} {r.link_key or '(unkeyed)':<52} {r.access:<15} {target[:66]}")


def list_blanks(reg: Register) -> int:
    blanks = [r for r in reg.rows if not (r.url or r.ref)]
    print(f"  {len(blanks)} row(s) with no link yet")
    for r in blanks:
        print(f"    {r.label}")
        print(f"      session {r.session_key or '(none)'}  owner {r.owner or '(none)'}")
        if r.note:
            print(f"      note: {r.note}")
    return 0


def coverage(reg: Register) -> int:
    """Two set differences, derived independently, and both printed.

    Not a partition. A partition of thirteen sessions sums to thirteen whatever
    `session_key` says, so the sum could not see a key pointing at the wrong row.
    And the report must NOT fail because the no-material list is empty: full
    coverage is the outcome the register wants, and a gate that goes red on
    success is worse than no gate.
    """
    sessions = session_keys(SESSION_MAP)
    covered = {r.session_key for r in reg.rows if r.active and r.session_key}
    all_claimed = {r.session_key for r in reg.rows if r.session_key}

    if not reg.rows:
        raise BuildError("coverage ran against zero register rows")
    no_material = sorted(sessions - covered)
    unknown = sorted(all_claimed - sessions)

    print(f"  {len(sessions)} session(s) in Session-Map.md, {len(reg.rows)} register row(s)")
    print(f"  sessions with no material: {len(no_material)}")
    for key in no_material:
        print(f"    {key}")
    print(f"  register session_key values matching no session: {len(unknown)}")
    for key in unknown:
        print(f"    {key}")
    if unknown:
        raise BuildError(
            "a register row points at a session key that does not exist. That is a "
            "mis-keyed row rather than a gap in the gathering."
        )
    return 0


# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--register", type=Path, default=REGISTER)
    ap.add_argument("--rules", type=Path, default=RULES)
    ap.add_argument("--out", type=Path, default=OUTPUT)
    ap.add_argument("--content", type=Path, default=None,
                    help="scratch site-content.json, for the refusal harness only")
    ap.add_argument("--session-map", type=Path, default=None)
    ap.add_argument("--print-rows", action="store_true")
    ap.add_argument("--print-badges", action="store_true",
                    help="the six on-screen badge strings, one per line, for the src/ grep")
    ap.add_argument("--list-blanks", action="store_true")
    ap.add_argument("--coverage", action="store_true")
    ap.add_argument("--allow-unsigned-links-register", action="store_true")
    ap.add_argument("--reason", default="")
    args = ap.parse_args()

    global CONTENT_OVERRIDE, SESSION_MAP
    if args.content:
        CONTENT_OVERRIDE = args.content
    if args.session_map:
        SESSION_MAP = args.session_map
    if args.print_badges:
        for spec in ACCESS.values():
            print(spec["badge"].replace("{owner}", "the owner"))
        return 0
    try:
        reg = load_register(args.register)
        rules = load_rules(args.rules)

        if args.list_blanks:
            return list_blanks(reg)

        print(f"  register {args.register}")
        print(f"  digest   {reg.digest[:16]}")
        validate(reg, rules, strict_sessions=not args.coverage)

        if args.print_rows:
            print_rows(reg)
            return 0
        if args.coverage:
            return coverage(reg)

        signed = bool(reg.meta.get("signed_off"))
        if not signed:
            if not args.allow_unsigned_links_register:
                raise BuildError(
                    f"{args.register.name} is not signed off, so nothing was written. "
                    "Sign it, or pass --allow-unsigned-links-register --reason \"...\"."
                )
            if not args.reason.strip():
                raise BuildError(
                    "--allow-unsigned-links-register needs --reason. This register is "
                    "regenerated for years by whoever is nearest, and an override with "
                    "no recorded reason becomes the normal way to run it."
                )
            print(f"  OVERRIDE: writing an unsigned register. Reason: {args.reason.strip()}")

        text = render_document(reg, content_nodes())
        args.out.write_text(text, encoding="utf-8")
        print_rows(reg)
        active = sum(1 for r in reg.rows if r.active)
        print(f"  wrote {args.out}")
        print(f"  {active} active row(s), {len(reg.rows) - active} skipped")
        return 0
    except BuildError as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
