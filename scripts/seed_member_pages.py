#!/usr/bin/env python3
"""Seed ONE member page from the vault into member_page / member_block.

Spec SITE-03 D4. Joshua authors member documents in Obsidian, where the vault is
private and git keeps the history; this reads one of them, turns it into blocks
in the site's own `Block` schema, and upserts it into the portal database. The
public repository never holds the prose.

    python3 scripts/seed_member_pages.py --route /members            # dry run
    python3 scripts/seed_member_pages.py --route /members --apply
    python3 scripts/seed_member_pages.py --route /members --emit-sql out.sql
    python3 scripts/seed_member_pages.py --list

## The four properties SITE-05's D0 has to read out of this file

They are settled here, deliberately, because three specs share this script and
discovering an answer from a refusal two specs later is the expensive way.

1.  **The vault-aware grep reads TRACKED AND UNTRACKED files through
    `git grep --untracked`, never ignored ones, and never the repository
    directory.** `.gitignore` lists `dist/`, and a build leaves every line of
    every page on disk there. A directory grep would therefore refuse a content
    move even after the public removal had been committed, which is program
    finding 16 and reads exactly like the ordering rule having failed.
    `--untracked` is the other half, and this build needed it: a member sentence
    sitting in a not-yet-committed harness file is still a leak, and a plain
    `git grep` cannot see it until after it has shipped.

2.  **It reads the WORKING TREE and not the history.** History on a public repo
    does not retract, so a grep over it would make a content move permanently
    impossible. History is answered by disclosure instead (SITE-03 finding 8),
    and `scripts/cdt00-history-scan.mjs` is the tool for it.

3.  **One run processes ONE named route.** `--route` is required and takes one
    value. A folder-wide run would let a session seeding one document silently
    rewrite every other member page from whatever its generator last produced.

4.  **The exempt set is a parameter, read from the document's own front matter**,
    per program finding 13. A resource that is already public cannot be
    un-published, so a member document carrying an already-public line would
    otherwise stop the seed forever. Every entry needs a reason, and the check
    PRINTS its population: an absence check whose population is not printed
    cannot be told apart from one that had nothing to look at (finding 12).

## What this refuses, and there are seven

    1. the named route is not marked `access: "member"` in site-content.json
    2. a node IS marked member and has no source file in the vault
    3. the named source file does not exist
    4. two vault files claim the same route
    5. the sentinel is missing, malformed, duplicated across documents, or
       absent from the document body
    6. a substantial line of the document is already in the site repo's tracked
       files and is not in the document's own exempt set
    7. the parsed document has no blocks, or a duplicate block id

## The authoring format

Front matter, then markdown. `##` opens a block, `###` opens a child block
inside its parent's `items`. Directly under a heading, `key: value` lines set
fields on that block; everything after them is the body.

    ---
    route: /members
    title: Member area
    sentinel: mbr-<32 hex>
    exempt:
      - line: "a line that is already public"
        reason: "why, and where it is already public"
    ---

    A paragraph before any heading becomes the leading block.

    ## What is here

    id: members.here
    type: prose
    anchor: s01-here

    Body paragraph.

`type` defaults to `prose`. Block ids have **two modes**, and the seed decides on
the presence of an explicit `id:` rather than on a flag. A document AUTHORED here
lets its ids be generated from the heading, so an anchor cannot drift from the
section it names. A document being MOVED declares every id, because the Psalms
page's 140 `bali.*` ids are React keys, `data-dfb-node` targets and the DOM-id
fallback for a section with no anchor, and generating new ones would discard all
three silently. `block_key` IS the block's own id, never a second string. **The
modes do not mix**: a document that declares any id and omits one is refused,
naming the blocks that have none (spec SITE-05 D4).

Three levels, and the third is a table. `##` is a block, `###` is a child, and a
markdown table under a `###` becomes that child's own `items`, read by header
name. That is what carries `listItem` under a `list` and `glanceCard` under a
`glanceGrid`; a `type` column says which, and the column defaults to `cta`.

A key line whose value is exactly `~` **removes** the field. Five of the blocks
SITE-05 moves carry no `title`, and a heading is what opens a block here, so
without `~` each would arrive wearing a title its public original never had.
A field the format cannot express is always a REFUSAL naming the block, the
field and the value, never a silent drop and never a guess.

## Writing

`--apply` posts SQL as `postgres` through the management API, the same footing as
`scripts/apply-migration.mjs` and with the same account denylist. Blocks that no
longer exist in the source are DELETED, so a removed section actually disappears;
that is also why two sessions must never run this concurrently on one project.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_VAULT = Path(
    os.environ.get(
        "OBT_CDT_VAULT",
        str(Path.home() / "Documents/Josh & Katie Vault/Claude Can Access PARA"),
    )
)
MEMBER_PAGES_SUBDIR = "Projects/OBT/OBT-CDT Central Hub/Member Pages"

REPO = Path(__file__).resolve().parent.parent
CONTENT_JSON = REPO / "src/content/site-content.json"
SENTINEL_MANIFEST = REPO / "scripts/member-sentinels.json"

SENTINEL_RE = re.compile(r"^mbr-[0-9a-f]{32}$")

# Fields a key line may set, taken from the `Block` interface in
# src/schema/types.ts. Anything else is a typo, and a typo silently dropped is a
# field that never reaches the page.
BLOCK_FIELDS = {
    "id", "type", "kicker", "title", "body", "label", "value", "note",
    "caption", "attribution", "mediaId", "route", "href", "variant",
    "stage", "anchor", "number",
}
INT_FIELDS = {"stage"}

# A line short enough to be a coincidence is not evidence of a leak. Both
# thresholds must be met, so "Travel, visas and packing" (a heading) does not
# make the whole gate noisy while a real sentence of prose always does.
SUBSTANTIAL_MIN_CHARS = 40
SUBSTANTIAL_MIN_WORDS = 7


class SeedError(Exception):
    """A refusal. Printed and exited on; never worked around."""


@dataclass
class ExemptEntry:
    line: str
    reason: str


@dataclass
class MemberDoc:
    path: Path
    route: str
    title: str
    sentinel: str
    kicker: str | None
    exempt: list[ExemptEntry]
    body: str
    blocks: list[dict] = field(default_factory=list)
    declared_ids: bool = False

    @property
    def digest(self) -> str:
        return hashlib.sha256(self.path.read_bytes()).hexdigest()


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def split_front_matter(text: str, path: Path) -> tuple[dict, str]:
    if not text.startswith("---\n"):
        raise SeedError(f"{path}: no front matter. The first line must be exactly ---")
    end = text.find("\n---\n", 3)
    if end == -1:
        raise SeedError(f"{path}: front matter is not closed by a --- line of its own")
    raw = text[4:end]
    try:
        import yaml
    except ModuleNotFoundError as exc:  # pragma: no cover - environment
        raise SeedError("PyYAML is needed to read a member document's front matter") from exc
    meta = yaml.safe_load(raw) or {}
    if not isinstance(meta, dict):
        raise SeedError(f"{path}: front matter is not a mapping")
    return meta, text[end + 5:]


def parse_exempt(meta: dict, path: Path) -> list[ExemptEntry]:
    """Every exempt line carries a reason, and the reason is not optional.

    Program finding 12: a line already public cannot be un-published, so an
    exemption is sometimes the only correct answer. An exemption without a stated
    reason is indistinguishable from a leak somebody silenced.
    """
    raw = meta.get("exempt") or []
    if not isinstance(raw, list):
        raise SeedError(f"{path}: `exempt` must be a list")
    out: list[ExemptEntry] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict) or "line" not in item or "reason" not in item:
            raise SeedError(
                f"{path}: exempt[{i}] must be a mapping with `line:` and `reason:`. "
                "An exemption with no stated reason is a leak somebody silenced."
            )
        out.append(ExemptEntry(str(item["line"]).strip(), str(item["reason"]).strip()))
    return out


def _key_lines(chunk: list[str]) -> tuple[dict, list[str]]:
    """Split a heading's body into its leading `key: value` lines and the rest."""
    fields: dict[str, str] = {}
    i = 0
    while i < len(chunk):
        line = chunk[i]
        if not line.strip():
            # A blank line only ends the key block once a key has been seen.
            if fields:
                i += 1
                break
            i += 1
            continue
        m = re.match(r"^([A-Za-z][A-Za-z0-9_]*):\s+(.*)$", line)
        if not m:
            break
        key, value = m.group(1), m.group(2).strip()
        if key not in BLOCK_FIELDS:
            raise SeedError(
                f"unknown block field `{key}`. Known fields: {', '.join(sorted(BLOCK_FIELDS))}"
            )
        fields[key] = value
        i += 1
    return fields, chunk[i:]


# A key line whose value is exactly this REMOVES the field rather than setting
# it. Spec SITE-05 D4: five of the moving blocks carry no `title` at all
# (`bali.09.general`, `bali.11.official`, `bali.03.map`, `bali.14.signup`,
# `bali.16.laundry.links`), and a heading is what opens a block here, so without
# this every one of them would arrive on the member page wearing a title the
# public page never showed. That is a field-level change to a MOVED document,
# which is the one thing a move may not do.
FIELD_UNSET = "~"


def _body_of(lines: list[str]) -> str:
    """Paragraphs, blank-line separated, with trailing whitespace dropped."""
    text = "\n".join(lines).strip()
    return re.sub(r"\n{3,}", "\n\n", text)


def _split_table(lines: list[str], path: Path) -> tuple[list[str], list[dict] | None]:
    """Split a heading's body into prose and ONE markdown table's rows.

    Spec SITE-04 D3's contribution to SITE-03's authoring format, and the second
    of the two entries in its mapping table. `##` to a section was already here;
    this is a markdown table to a block's `items`.

    Read BY HEADER NAME, so the two register tables can carry different columns
    and adding a column to one cannot shift another's values one place left. A
    header naming something that is not a `Block` field is a REFUSAL rather than
    a drop, because a silently dropped column is a field that never reaches the
    page and looks exactly like a field nobody filled in.
    """
    prose: list[str] = []
    rows: list[dict] = []
    header: list[str] | None = None
    in_table = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("|"):
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            if header is None:
                header = [c.strip("`") for c in cells]
                unknown = [h for h in header if h not in BLOCK_FIELDS]
                if unknown:
                    raise SeedError(
                        f"{path}: table column(s) {', '.join(unknown)} are not Block "
                        f"fields. Known fields: {', '.join(sorted(BLOCK_FIELDS))}. A "
                        "column the seed cannot map is refused rather than dropped."
                    )
                in_table = True
                continue
            if all(set(c) <= set("-: ") for c in cells):
                continue
            if len(cells) != len(header):
                raise SeedError(
                    f"{path}: a table row has {len(cells)} cells and its header has "
                    f"{len(header)}"
                )
            row = {
                k: v.replace("\\|", "|")
                for k, v in zip(header, cells)
                if v and v != FIELD_UNSET
            }
            if not row.get("id"):
                raise SeedError(
                    f"{path}: a table row has no `id`. The renderer keys its cards on "
                    "it, so a row without one collides with its neighbour."
                )
            row.setdefault("type", "cta")
            rows.append(row)
            continue
        if in_table and stripped:
            raise SeedError(
                f"{path}: prose after a table inside one section. Put it above the "
                "table or open a new section, or the reading order stops matching "
                "the source."
            )
        prose.append(line)
    return prose, (rows if in_table else None)


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s or "block"


def parse_blocks(doc_body: str, route: str, path: Path) -> tuple[list[dict], bool]:
    """Markdown to blocks. Returns the blocks and whether ids were declared."""
    lines = doc_body.split("\n")
    # (level, heading, [body lines]); level 0 is the preamble before any heading.
    sections: list[tuple[int, str, list[str]]] = [(0, "", [])]
    for line in lines:
        m = re.match(r"^(##|###)\s+(.*)$", line)
        if m:
            sections.append((len(m.group(1)), m.group(2).strip(), []))
        elif re.match(r"^#\s+", line):
            raise SeedError(
                f"{path}: a single-# heading is the document title, which comes from "
                "front matter. Start block headings at ##."
            )
        else:
            sections[-1][2].append(line)

    prefix = _slug(route.strip("/")) or "member"
    blocks: list[dict] = []
    declared = False
    generated: list[str] = []
    counter = 0

    for level, heading, chunk in sections:
        fields, rest = _key_lines(chunk)
        rest, table = _split_table(rest, path)
        body = _body_of(rest)
        if level == 0 and not body and not table:
            continue  # no preamble

        counter += 1
        # `~` unsets a field, and there are exactly two fields it may NOT unset.
        # Spec SITE-05's review finding 6: both keys are read below, BEFORE the
        # unset loop runs, so `id: ~` was accepted as the literal string "~" and
        # became a `block_key`, and `type: ~` was accepted and renders nothing.
        for reserved in ("id", "type"):
            if fields.get(reserved) == FIELD_UNSET:
                raise SeedError(
                    f"{path}: `{reserved}: {FIELD_UNSET}` under {heading or '(preamble)'!r}. "
                    f"`{FIELD_UNSET}` removes an OPTIONAL field; `{reserved}` is not one. "
                    "Every block needs a type, and a block needs either a declared id or "
                    "none at all so its id can be generated."
                )
        if "id" in fields:
            declared = True
            block_id = fields.pop("id").strip()
            if not block_id:
                # `id:` with only whitespace after it parsed as an empty string
                # with `declared=True` and nothing in `generated`, so the D4
                # refusal below could never fire and `block_key` became ''.
                raise SeedError(
                    f"{path}: an empty `id:` under {heading or '(preamble)'!r}. That is a "
                    "MISSING id, not a declared one: it would become an empty block_key. "
                    "Give the block its id, or delete the line and let it be generated."
                )
        else:
            base = _slug(heading) if heading else "intro"
            block_id = f"{prefix}.{counter:02d}.{base}"
            generated.append(f"{heading or '(preamble)'} -> {block_id}")

        block: dict = {"id": block_id, "type": fields.pop("type", "prose")}
        if heading:
            block["title"] = heading
        for key, value in fields.items():
            if value == FIELD_UNSET:
                block.pop(key, None)
                continue
            block[key] = int(value) if key in INT_FIELDS else value
        if body:
            block["body"] = body
        if table is not None:
            if not table:
                raise SeedError(f"{path}: a table under {heading!r} has a header and no rows")
            block["items"] = table

        if level == 3:
            if not blocks:
                raise SeedError(f"{path}: a ### heading with no ## heading above it")
            blocks[-1].setdefault("items", []).append(block)
        else:
            blocks.append(block)

    # Mixed modes would give one document two id namespaces, which is how an
    # anchor and the section it names come apart. Spec SITE-05 D4 makes this a
    # REFUSAL rather than a comment: a document being moved declares every id,
    # because the ids it is moving are React keys, `data-dfb-node` targets and
    # the DOM-id fallback for a section with no anchor (finding 3). One block
    # left undeclared in such a document gets a generated `psalms-bali-2026.07.x`
    # id, renders fine, and quietly breaks all three.
    if declared and generated:
        listing = "\n".join(f"      {g}" for g in generated[:10])
        raise SeedError(
            f"{path}: this document DECLARES block ids, and {len(generated)} block(s) "
            f"do not:\n{listing}\n"
            "    A moved document declares every id or none. Add `id:` to each, or "
            "remove the declared ones and let all of them be generated from headings."
        )
    ids_seen: set[str] = set()

    def walk(bs: list[dict]) -> None:
        for b in bs:
            if b["id"] in ids_seen:
                raise SeedError(f"{path}: duplicate block id `{b['id']}`")
            ids_seen.add(b["id"])
            walk(b.get("items", []))

    walk(blocks)
    return blocks, declared


def load_doc(path: Path) -> MemberDoc:
    text = path.read_text(encoding="utf-8")
    meta, body = split_front_matter(text, path)
    for required in ("route", "title", "sentinel"):
        if not meta.get(required):
            raise SeedError(f"{path}: front matter is missing `{required}:`")
    sentinel = str(meta["sentinel"]).strip()
    if not SENTINEL_RE.match(sentinel):
        raise SeedError(
            f"{path}: sentinel `{sentinel}` is not of the form mbr-<32 hex>. "
            "It must be opaque: the manifest is published in a public repo, so a "
            "sentinel that is a sentence puts member prose there."
        )
    if sentinel not in body:
        raise SeedError(
            f"{path}: the sentinel does not appear in the document BODY. It has to, "
            "or a wholesale copy of this document into the repo would carry no marker "
            "for scripts/member-content-gate.mjs to find."
        )
    doc = MemberDoc(
        path=path,
        route=str(meta["route"]).strip(),
        title=str(meta["title"]).strip(),
        sentinel=sentinel,
        kicker=(str(meta["kicker"]).strip() if meta.get("kicker") else None),
        exempt=parse_exempt(meta, path),
        body=body,
    )
    doc.blocks, doc.declared_ids = parse_blocks(body, doc.route, path)
    if not doc.blocks:
        raise SeedError(f"{path}: parsed to zero blocks. A member page with no body is not a page.")
    return doc


# ---------------------------------------------------------------------------
# The content-layer contract
# ---------------------------------------------------------------------------

def member_nodes() -> dict[str, str]:
    """Route to kind, for every node marked member.

    The kind matters. A member PAGE gets a gated route and therefore needs a
    body, a source file and a sentinel. A member WORKSHOP gets none of those:
    `access: "member"` on a workshop means "not published", enforced by
    `WorkshopPage`'s own refusal, because `/workshops/:slug` is a route PATTERN
    and no list can unregister a pattern. It renders nothing, so there is nothing
    to seed and nothing to grep for.
    """
    content = json.loads(CONTENT_JSON.read_text(encoding="utf-8"))
    nodes: dict[str, str] = {}
    for node in content["pages"]:
        if node.get("access") == "member":
            nodes[node["route"]] = "page"
    for node in content["workshops"]:
        if node.get("access") == "member":
            nodes[node["route"]] = "workshop"
    return nodes


def scan_vault(folder: Path) -> tuple[dict[str, Path], list[str]]:
    """Route to file, refusing two files that claim one route.

    A markdown file with no `route:` in its front matter is NOT a member page: the
    folder also holds the authoring runbook Joshua reads in Obsidian. Those are
    skipped and PRINTED rather than skipped silently, because a mistyped `rout:`
    would otherwise vanish here. It is still loud either way — the node it should
    have matched then has no source file, which `check_contract` refuses by name.
    """
    if not folder.is_dir():
        raise SeedError(f"member pages folder not found: {folder}")
    by_route: dict[str, Path] = {}
    skipped: list[str] = []
    for path in sorted(folder.glob("*.md")):
        text = path.read_text(encoding="utf-8")
        try:
            meta, _ = split_front_matter(text, path)
        except SeedError:
            skipped.append(f"{path.name} (no front matter)")
            continue
        route = str(meta.get("route", "")).strip()
        if not route:
            skipped.append(f"{path.name} (no `route:`)")
            continue
        if route in by_route:
            raise SeedError(f"two vault files claim route {route}: {by_route[route].name} and {path.name}")
        by_route[route] = path
    return by_route, skipped


def check_contract(route: str, nodes: dict[str, str], files: dict[str, Path]) -> None:
    """Refusals 1, 2 and 3, checked over the whole set rather than one route.

    Deliberately whole-set: refusal 2 is a node marked member with NO file, which
    a per-route run would never see. Reading is cheap and writing is what stays
    scoped to one route.
    """
    if route not in nodes:
        marked = ", ".join(sorted(nodes)) or "none"
        raise SeedError(
            f"no node in site-content.json marks {route} as access: \"member\". "
            f"Marked member today: {marked}."
        )
    if nodes[route] == "workshop":
        raise SeedError(
            f"{route} is a member WORKSHOP, which has no body to seed. A workshop "
            "marked member is refused by WorkshopPage, not re-rendered: it gets no "
            "member route, because its `facts` are rendered by components a member "
            "page knows nothing about. Gate a workshop's specifics with a member PAGE."
        )
    member_pages = {r for r, kind in nodes.items() if kind == "page"}
    orphan_nodes = sorted(member_pages - set(files))
    if orphan_nodes:
        raise SeedError(
            "these routes are marked member in site-content.json and have no source "
            f"file in the vault: {', '.join(orphan_nodes)}. A gated route with no body "
            "is a sign-in card in front of an empty page."
        )
    orphan_files = sorted(set(files) - member_pages)
    if orphan_files:
        raise SeedError(
            "these vault documents claim routes that no node marks member: "
            f"{', '.join(orphan_files)}. Seeding one would put a body in the database "
            "that nothing renders and no gate watches."
        )


def check_sentinels(files: dict[str, Path]) -> dict[str, str]:
    """Refusal 5's duplication half, which only a whole-set read can see."""
    by_route: dict[str, str] = {}
    seen: dict[str, str] = {}
    for route, path in sorted(files.items()):
        meta, _ = split_front_matter(path.read_text(encoding="utf-8"), path)
        sentinel = str(meta.get("sentinel", "")).strip()
        if sentinel in seen:
            raise SeedError(
                f"sentinel {sentinel} is used by both {seen[sentinel]} and {route}. "
                "One token per document, or the gate cannot say which document leaked."
            )
        seen[sentinel] = route
        by_route[route] = sentinel
    return by_route


# ---------------------------------------------------------------------------
# The vault-aware half of the gate
# ---------------------------------------------------------------------------

def substantial_lines(doc: MemberDoc) -> list[str]:
    """Strings distinctive enough that finding one in the repo means a leak.

    ## Table cells are lines, and this is spec SITE-05's review finding 2

    The first version skipped any line starting with `|`. Measured on the Psalms
    member document, that skipped **49 table rows and 4,700 characters**, and
    those rows are where the street address, the rooming rows, the meal times
    and the laundry prices live: precisely the facts a member document exists to
    gate. The gate was checking 36 of 207 body lines and reporting a pass.

    The consequence was not theoretical. Had SITE-05's removal commit left the
    `bali.03.venue` grid behind, this gate would NOT have refused, and the build
    would have reported the ordering rule working while the address stayed
    public. So a table row is split on `|` and every substantial cell is checked
    on its own.

    ## Both forms of every line, because markdown survives a paste into JSON

    The first version stripped `*_`[]` and matched only the stripped form, while
    `site-content.json` keeps the markdown. So a moved paragraph whose only
    offence was `**Bring your own blanket.**` was invisible to the gate. Both
    forms are returned now: the raw line, which is what a paste into JSON looks
    like, and the stripped one, which is what a paste into a `.tsx` string or a
    prose document looks like. A leak in either shape is a leak.
    """
    out: list[str] = []
    seen: set[str] = set()

    def consider(text: str) -> None:
        text = text.strip()
        if not text or doc.sentinel in text:
            return
        if len(text) < SUBSTANTIAL_MIN_CHARS or len(text.split()) < SUBSTANTIAL_MIN_WORDS:
            return
        if text not in seen:
            seen.add(text)
            out.append(text)

    for raw in doc.body.split("\n"):
        line = raw.strip()
        if not line or line.startswith(("#", ">", "---")):
            continue
        if line.startswith("|"):
            # A separator row carries no content; every other cell is a string
            # somebody could have pasted into the repo.
            cells = [c.strip() for c in line.strip("|").split("|")]
            if all(set(c) <= set("-: ") for c in cells if c):
                continue
            for cell in cells:
                consider(cell)
                consider(re.sub(r"[*_`\[\]]", "", cell))
            continue
        stripped = re.sub(r"[*_`\[\]]", "", line)
        stripped = re.sub(r"^\s*[-+*]\s+", "", stripped)
        stripped = re.sub(r"^[A-Za-z][A-Za-z0-9_]*:\s+", "", stripped)
        bare = re.sub(r"^\s*[-+*]\s+", "", line)
        bare = re.sub(r"^[A-Za-z][A-Za-z0-9_]*:\s+", "", bare)
        consider(bare)
        consider(stripped)
    return out


def repo_grep(needle: str) -> list[str]:
    """`git grep --untracked` over the working tree. See header properties 1 and 2.

    `--untracked` adds files git does not track YET but would, and stops short of
    ignored ones. Both halves matter. Without it, a leak sitting in a file that
    has not been committed is invisible until after it has shipped, which this
    build hit for real: the browser harness held a member sentence and the plain
    `git grep` could not see it because the harness itself was still untracked.
    And it must NOT reach ignored files, because `.gitignore:3` lists `dist/` and
    a build leaves every line of every page there, so including it would refuse a
    content move even after the public removal was committed (program finding 16).
    """
    proc = subprocess.run(
        ["git", "grep", "-l", "-F", "--untracked", "--", needle],
        cwd=REPO, capture_output=True, text=True,
    )
    if proc.returncode not in (0, 1):
        raise SeedError(f"git grep failed: {proc.stderr.strip()}")
    return [line for line in proc.stdout.split("\n") if line.strip()]


def vault_aware_gate(doc: MemberDoc) -> None:
    lines = substantial_lines(doc)
    exempt_text = {e.line for e in doc.exempt}
    checked = [line for line in lines if line not in exempt_text]
    skipped = [line for line in lines if line in exempt_text]

    print(f"  vault-aware gate: {len(lines)} substantial line(s) in {doc.path.name}")
    print(f"    checked {len(checked)}, exempt {len(skipped)}")
    for entry in doc.exempt:
        used = "used" if entry.line in exempt_text and entry.line in lines else "UNUSED"
        print(f"      exempt [{used}] {entry.line[:60]!r}: {entry.reason}")
    if not checked:
        raise SeedError(
            f"{doc.path}: no substantial line survives the exempt set, so this gate "
            "would pass on an empty population and prove nothing."
        )

    hits: list[tuple[str, list[str]]] = []
    for line in checked:
        found = repo_grep(line)
        if found:
            hits.append((line, found))
    if hits:
        detail = "\n".join(f"      {line[:70]!r} -> {', '.join(files)}" for line, files in hits[:10])
        raise SeedError(
            f"{len(hits)} line(s) of {doc.path.name} are already in the site repo's tracked "
            f"files:\n{detail}\n"
            "    Remove them from the repo and commit BEFORE seeding, or add each to the "
            "document's `exempt:` list with a reason if it is already public and cannot be "
            "retracted (program finding 12)."
        )
    print(f"    no leak: {len(checked)} line(s) absent from the repo's tracked files")


# ---------------------------------------------------------------------------
# SQL
# ---------------------------------------------------------------------------

def sql_literal(value) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def rows_for(doc: MemberDoc) -> list[dict]:
    rows = []
    for ordinal, block in enumerate(doc.blocks):
        rows.append({
            "route": doc.route,
            "block_key": block["id"],
            "ordinal": ordinal,
            "anchor": block.get("anchor"),
            "block": json.dumps(block, ensure_ascii=False, sort_keys=True),
        })
    return rows


def build_sql(doc: MemberDoc) -> str:
    rows = rows_for(doc)
    keys = ", ".join(sql_literal(r["block_key"]) for r in rows)
    parts = [
        "-- scripts/seed_member_pages.py, spec SITE-03. Generated; do not hand-edit.",
        f"-- route {doc.route}  source {doc.path.name}  digest {doc.digest[:16]}…",
        "insert into public.member_page (route, kicker, source_digest, sentinel, updated_at) values (",
        f"  {sql_literal(doc.route)}, {sql_literal(doc.kicker)}, {sql_literal(doc.digest)}, {sql_literal(doc.sentinel)}, now())",
        "on conflict (route) do update set",
        "  kicker = excluded.kicker, source_digest = excluded.source_digest,",
        "  sentinel = excluded.sentinel, updated_at = now();",
        "",
    ]
    for row in rows:
        parts.append(
            "insert into public.member_block (route, block_key, ordinal, anchor, block) values (\n"
            f"  {sql_literal(row['route'])}, {sql_literal(row['block_key'])}, {row['ordinal']},\n"
            f"  {sql_literal(row['anchor'])}, {sql_literal(row['block'])}::jsonb)\n"
            "on conflict (route, block_key) do update set\n"
            "  ordinal = excluded.ordinal, anchor = excluded.anchor, block = excluded.block;"
        )
    parts += [
        "",
        "-- A section removed from the source has to disappear, not linger. This is",
        "-- also why two sessions must never run this concurrently on one project.",
        f"delete from public.member_block where route = {sql_literal(doc.route)}",
        f"  and block_key not in ({keys});",
    ]
    return "\n".join(parts) + "\n"


def post_sql(sql: str) -> None:
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

    # `fetch` from Node, not urllib: api.supabase.com answers urllib's default
    # User-Agent with HTTP 403 Cloudflare 1010, which reads exactly like a bad
    # token (sibling finding 26). A stated User-Agent is what makes it work.
    request = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{ref}/database/query",
        data=json.dumps({"query": sql}).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "obt-cdt-seed-member-pages/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            body = response.read().decode()
    except urllib.error.HTTPError as exc:
        raise SeedError(f"management API {exc.code}: {exc.read().decode()[:400]}") from exc
    if body.strip() and body.strip() != "[]":
        print(f"  api: {body[:300]}")


def write_manifest(route: str, sentinel: str, nodes: dict[str, str]) -> tuple[int, list[str]]:
    """Route to token, pruned to the member PAGES. Carries no prose.

    Workshops are absent by design: a member workshop renders nothing, so it has
    no prose to leak and no token to look for. The gate knows the same rule and
    fails on a member page with no entry here.
    """
    pages = {r for r, kind in nodes.items() if kind == "page"}
    existing = {}
    if SENTINEL_MANIFEST.exists():
        existing = json.loads(SENTINEL_MANIFEST.read_text(encoding="utf-8")).get("sentinels", {})
    pruned = [r for r in existing if r not in pages]
    manifest = {r: t for r, t in existing.items() if r in pages}
    manifest[route] = sentinel
    SENTINEL_MANIFEST.write_text(
        json.dumps(
            {
                "_README": (
                    "Spec SITE-03. Route to opaque sentinel token, written by "
                    "scripts/seed_member_pages.py and read by scripts/member-content-gate.mjs. "
                    "The tokens carry no prose, so publishing them in a public repo leaks "
                    "nothing; finding one of them in dist/ or src/ means member content has "
                    "been pasted into a public artifact. A member node with no entry here "
                    "fails the build: its body has never been checked."
                ),
                "sentinels": dict(sorted(manifest.items())),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return len(manifest), pruned


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--route", help="the single member route to seed")
    ap.add_argument("--apply", action="store_true", help="write; the default is a dry run")
    ap.add_argument("--emit-sql", type=Path, metavar="FILE", help="write the SQL and stop")
    ap.add_argument("--list", action="store_true", help="list member nodes and their source files")
    ap.add_argument("--vault", type=Path, default=DEFAULT_VAULT)
    ap.add_argument(
        "--skip-repo-grep",
        action="store_true",
        help="skip the vault-aware gate. For the gate's own mutation test only; it prints a warning.",
    )
    args = ap.parse_args()

    folder = args.vault / MEMBER_PAGES_SUBDIR
    try:
        nodes = member_nodes()
        files, skipped = scan_vault(folder)

        if args.list:
            print(f"member nodes in {CONTENT_JSON.name}: {len(nodes)}")
            for route in sorted(set(nodes) | set(files)):
                kind = nodes.get(route, "NO NODE")
                src = files[route].name if route in files else "NO FILE"
                print(f"  {route:32} {kind:9} {src}")
            for name in skipped:
                print(f"  skipped, not a member page: {name}")
            return 0

        if not args.route:
            ap.error("--route is required (one route per run; see the header)")

        check_contract(args.route, nodes, files)
        sentinels = check_sentinels(files)
        doc = load_doc(files[args.route])

        print(f"seed_member_pages: {args.route}")
        for name in skipped:
            print(f"  skipped, not a member page: {name}")
        print(f"  source     : {doc.path}")
        print(f"  digest     : {doc.digest[:16]}…")
        print(f"  sentinel   : {doc.sentinel}")
        print(f"  blocks     : {len(doc.blocks)} top level, "
              f"{sum(len(b.get('items', [])) for b in doc.blocks)} nested")
        print(f"  block ids  : {'declared in the document' if doc.declared_ids else 'generated from headings'}")
        anchors = [b["anchor"] for b in doc.blocks if b.get("anchor")]
        print(f"  anchors    : {len(anchors)}" + (f"  {', '.join(anchors)}" if anchors else ""))

        if args.skip_repo_grep:
            print("  vault-aware gate: SKIPPED by --skip-repo-grep. This is not a pass.")
        else:
            vault_aware_gate(doc)

        sql = build_sql(doc)
        if args.emit_sql:
            args.emit_sql.write_text(sql, encoding="utf-8")
            print(f"  wrote {args.emit_sql} ({len(sql.splitlines())} lines). Nothing was applied.")
            return 0

        if not args.apply:
            print(f"\n  DRY RUN. {len(doc.blocks)} block row(s) would be written and any other "
                  f"block on {args.route} deleted. Re-run with --apply.")
            return 0

        post_sql(sql)
        total, pruned = write_manifest(args.route, doc.sentinel, nodes)
        assert sentinels[args.route] == doc.sentinel
        print(f"\n  applied. {SENTINEL_MANIFEST.name} now holds {total} route(s)."
              + (f" Pruned: {', '.join(pruned)}." if pruned else ""))
        return 0
    except SeedError as exc:
        print(f"\nREFUSED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
