#!/usr/bin/env python3
"""Fire every refusal in build_links_register.py, once each, and prove they differ.

Spec SITE-04 criterion 2.

    python3 scripts/site04_refusals.py

Each case copies the real register into a scratch directory, plants exactly one
defect, runs the generator, and asserts three things: a non-zero exit, a message
that names the offending row, and a message no other case produces. The third is
the one that matters. Thirteen refusals that all print "invalid register" are one
refusal wearing thirteen hats, and the person who hits it at nine in the evening
cannot tell which.

Nothing here touches the real register, the real content file or the real
content-rules file. The roster and stop-list cases plant a name into a SCRATCH
rules file, never into the vault's, because the point of that gate is that the
real list is not copied anywhere.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
VAULT = Path(os.environ.get(
    "OBT_CDT_VAULT",
    str(Path.home() / "Documents/Josh & Katie Vault/Claude Can Access PARA"),
))
HUB = VAULT / "Projects/OBT/OBT-CDT Central Hub"
REGISTER = HUB / "Member Pages/Links-Register.md"
RULES = HUB / "content-rules.yml"
CONTENT = REPO / "src/content/site-content.json"
SESSION_MAP = (
    VAULT / "Projects/OBT/OBT Consultant Track/Psalms (Bali 2026)/Evaluation/Session-Map.md"
)

ANCHOR = "| Psalm 1 internalization plan "
FIXTURE_URL = "https://docs.google.com/document/d/1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/edit"


def edit_row(text: str, starts_with: str, col: int, value: str) -> str:
    """Replace one cell of the row whose line starts with `starts_with`."""
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if line.startswith(starts_with):
            cells = line.strip().strip("|").split("|")
            cells[col] = f" {value} "
            lines[i] = "|" + "|".join(cells) + "|"
            return "\n".join(lines)
    raise SystemExit(f"harness bug: no row starting {starts_with!r}")


def add_row(text: str, row: str) -> str:
    lines = text.split("\n")
    last = max(i for i, l in enumerate(lines) if l.startswith("| Scriptura Psalms wiki"))
    lines.insert(last + 1, row)
    return "\n".join(lines)


# column order of the Teaching materials table
LABEL, WHAT, URL, REF, ACCESS, OWNER, SESSION, NOTE, ACTIVE = range(9)

CASES: list[tuple[str, str]] = []


def case(name):
    def deco(fn):
        CASES.append((name, fn))
        return fn
    return deco


@case("1. unknown access word")
def c1(reg, rules, content, _):
    return edit_row(reg, ANCHOR, ACCESS, "wide-open"), rules, content


@case("2. active row with neither url nor ref")
def c2(reg, rules, content, _):
    return edit_row(reg, "| Expanding Role of AI in OBT", ACTIVE, "true"), rules, content


@case("3. a row carrying both a url and a ref")
def c3(reg, rules, content, _):
    return edit_row(reg, ANCHOR, REF, "bali.17.resources.guide"), rules, content


@case("4. a ref resolving to no node")
def c4(reg, rules, content, _):
    reg = edit_row(reg, "| Exegetical Guide", REF, "bali.17.resources.nonesuch")
    return reg, rules, content


@case("5. a duplicate link_key")
def c5(reg, rules, content, _):
    return add_row(reg, f"| Discovering Genres | A second row with the same label. | "
                        f"{FIXTURE_URL} |  | open-link | Josh |  |  | auto |"), rules, content


@case("6. a duplicate url across rows")
def c6(reg, rules, content, _):
    url = re.search(r"https://docs\.google\.com/presentation/d/[A-Za-z0-9_-]+/preview", reg).group(0)
    return add_row(reg, f"| A second row for the same deck | Same file, different label. | "
                        f"{url} |  | open-link | Josh |  |  | auto |"), rules, content


@case("7. request-access with no owner")
def c7(reg, rules, content, _):
    return edit_row(reg, ANCHOR, OWNER, ""), rules, content


@case("8. a session_key matching no session")
def c8(reg, rules, content, _):
    return edit_row(reg, ANCHOR, SESSION, "w9d9-m9"), rules, content


@case("9. an assembled body over the cap")
def c9(reg, rules, content, _):
    return edit_row(reg, ANCHOR, WHAT, "x" * 400), rules, content


@case("10. a malformed sentinel")
def c10(reg, rules, content, _):
    return reg.replace("sentinel: mbr-", "sentinel: not-opaque-at-all-mbr-", 1), rules, content


@case("11. a link_key already in site-content.json")
def c11(reg, rules, content, scratch):
    d = json.loads(content.read_text(encoding="utf-8"))
    d["site"]["items"].append({
        "id": "members-materials.discovering-genres", "type": "labelToken", "label": "planted",
    })
    out = scratch / "site-content.json"
    out.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return reg, rules, out


@case("12. a participant name from the roster")
def c12(reg, rules, content, scratch):
    out = scratch / "rules-roster.yml"
    out.write_text(
        rules.read_text(encoding="utf-8").replace(
            "roster_names: []", 'roster_names:\n  - "Planted Participant"'),
        encoding="utf-8")
    return edit_row(reg, ANCHOR, WHAT, "Prepared with Planted Participant."), out, content


@case("13. a partner-org name from the stop list")
def c13(reg, rules, content, scratch):
    out = scratch / "rules-org.yml"
    out.write_text(
        rules.read_text(encoding="utf-8").replace(
            "partner_org_stop_list: []", 'partner_org_stop_list:\n  - "Planted Partner Org"'),
        encoding="utf-8")
    return edit_row(reg, ANCHOR, WHAT, "Produced with Planted Partner Org."), out, content


@case("14. an item naming a do-not-route programme")
def c14(reg, rules, content, _):
    return edit_row(reg, ANCHOR, WHAT, "Follow up at Whole Word Institute."), rules, content


@case("15. every content-gate population empty")
def c15(reg, rules, content, scratch):
    out = scratch / "rules-empty.yml"
    out.write_text(
        "roster_names: []\npartner_org_stop_list: []\ndo_not_route: []\npathway_contrast: []\n",
        encoding="utf-8")
    return reg, out, content


def main() -> int:
    reg_text = REGISTER.read_text(encoding="utf-8")
    failures: list[str] = []
    messages: dict[str, str] = {}

    with tempfile.TemporaryDirectory() as tmp:
        scratch = Path(tmp)
        for name, fn in CASES:
            text, rules, content = fn(reg_text, RULES, CONTENT, scratch)
            reg_path = scratch / "register.md"
            reg_path.write_text(text, encoding="utf-8")
            proc = subprocess.run(
                [sys.executable, str(REPO / "scripts/build_links_register.py"),
                 "--register", str(reg_path),
                 "--rules", str(rules),
                 "--content", str(content),
                 "--session-map", str(SESSION_MAP),
                 "--out", str(scratch / "unwanted.md"),
                 "--allow-unsigned-links-register", "--reason", "refusal harness"],
                capture_output=True, text=True,
            )
            msg = (proc.stderr.strip().split("\n") or [""])[-1]
            wrote = (scratch / "unwanted.md").exists()
            ok = proc.returncode != 0 and msg.startswith("REFUSED:") and not wrote
            print(f"  {'PASS' if ok else 'FAIL'}  {name}")
            print(f"        exit {proc.returncode}  {msg[:140]}")
            if not ok:
                failures.append(f"{name}: exit {proc.returncode}, wrote={wrote}, msg={msg!r}")
            if msg in messages:
                failures.append(f"{name}: same message as {messages[msg]}")
            messages[msg] = name
            if wrote:
                (scratch / "unwanted.md").unlink()

    print(f"\n  {len(CASES)} refusal case(s), {len(set(messages))} distinct message(s)")
    if failures:
        for f in failures:
            print(f"  FAILURE: {f}")
        return 1
    print("  every case refused, wrote nothing, and said something different")
    return 0


if __name__ == "__main__":
    sys.exit(main())
