#!/usr/bin/env python3
"""Seed ONE review quiz from the vault into quiz / quiz_question / quiz_choice.

Spec SITE-19 D4. Joshua writes a quiz in Obsidian; this reads it, checks it, and
upserts it into the portal database as `postgres`. The quiz text is member
content, so it never enters this public repository.

    python3 scripts/seed_review_quiz.py --source "<vault>/.../Psalms-Quiz-1.md"           # dry run
    python3 scripts/seed_review_quiz.py --source "<vault>/.../Psalms-Quiz-1.md" --apply
    python3 scripts/seed_review_quiz.py --self-test

## The authoring format

Front matter carries `quiz_key`, `title`, `review_route`, `review_anchor`,
`review_block` and `signed_off`, and NO `route:` key, so `seed_member_pages.py`
skips the file and prints it as skipped. The body is an Obsidian ordered list:

    1. Stem of the first question
        1. Choice A
        2. Choice B
        3. Choice C
        4. Choice D
        5. Answer: C. An optional explanation.

The answer is the FIRST letter after `Answer:`. When a period follows it, the
prose after `X.` is the explanation. Quiz 1's question 4 reads `Answer: B is not
as reliable...`: the letter is part of the sentence there, so the whole
remainder after `Answer:` is kept as the explanation, letter included.

## What this refuses, each with a message naming the item

     1. `--apply` while `signed_off` is not true
     2. a question with fewer than 2 or more than 6 choices
     3. a question with no `Answer:` line
     4. an answer letter outside the question's choice range
     5. a gap in the question numbering
     6. a second file in the same folder carrying the same `quiz_key`
     7. a structural change (a question or choice added or removed) to a quiz
        that already has attempts
     8. a leak-gate hit: a stem, explanation or long choice already in the repo
     9. an empty leak-gate population
    10. a project ref on the denylist (inherited from `post_sql`)

## The leak gate

The same idea as `seed_member_pages.py`'s vault-aware gate, and it imports that
file's `repo_grep` rather than copying it: `git grep -F --untracked` over the
working tree, never ignored files (so `dist/` is out), never history. Every stem,
every explanation and every choice label of at least 40 characters and 7 words
is checked, in raw and markdown-stripped forms. The population is printed, and
an empty one is refused, because an absence check over nothing proves nothing.

`--self-test` proves the gate is the reason for a refusal: it generates its own
quiz (never the real vault file), confirms the gate passes it clean, plants one
generated stem in an untracked file under `scripts/`, confirms the refusal, and
deletes the file in a `finally`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import secrets
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from seed_member_pages import (  # noqa: E402  (the shared helpers, imported not edited)
    REPO,
    SUBSTANTIAL_MIN_CHARS,
    SUBSTANTIAL_MIN_WORDS,
    SeedError,
    post_sql,
    repo_grep,
    split_front_matter,
)

KEY_RE = re.compile(r"^[a-z0-9-]+$")
QUESTION_RE = re.compile(r"^(\d+)\.\s+(.*\S)\s*$")
CHOICE_RE = re.compile(r"^[ \t]+(\d+)\.\s+(.*\S)\s*$")
ANSWER_RE = re.compile(r"^Answer:\s*(([A-Za-z])\b(\.?)\s*(.*))$", re.S)
LETTERS = "abcdef"
FORBIDDEN_REFS = {
    "vdbirmjvjzfdgajwgowj": "Honest Eval (repo `cairn`)",
    "ckorlrchryswnnrmuctr": "the Local Genres Research app",
}


@dataclass
class Question:
    number: int
    stem: str
    choices: list[str] = field(default_factory=list)
    answer: str | None = None  # 'a'..'f'
    explanation: str | None = None

    @property
    def key(self) -> str:
        return f"q{self.number:02d}"


@dataclass
class Quiz:
    path: Path
    meta: dict
    questions: list[Question]
    digest: str

    @property
    def key(self) -> str:
        return str(self.meta["quiz_key"])


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def parse_quiz(path: Path) -> Quiz:
    text = path.read_text(encoding="utf-8")
    meta, body = split_front_matter(text, path)
    if "route" in meta:
        raise SeedError(f"{path.name}: a quiz file must not carry `route:`; seed_member_pages.py would read it as a page")
    for required in ("quiz_key", "title", "review_route"):
        if not str(meta.get(required, "")).strip():
            raise SeedError(f"{path.name}: front matter has no `{required}`")
    if not KEY_RE.match(str(meta["quiz_key"])):
        raise SeedError(f"{path.name}: quiz_key {meta['quiz_key']!r} is not lowercase letters, digits and hyphens")

    questions: list[Question] = []
    current: Question | None = None
    for line in body.split("\n"):
        q = QUESTION_RE.match(line)
        if q:
            current = Question(number=int(q.group(1)), stem=q.group(2))
            questions.append(current)
            continue
        c = CHOICE_RE.match(line)
        if c and current is not None:
            item = c.group(2)
            if item.startswith("Answer:"):
                if current.answer is not None:
                    raise SeedError(f"{path.name}: question {current.number} has two `Answer:` lines")
                a = ANSWER_RE.match(item)
                if not a:
                    raise SeedError(f"{path.name}: question {current.number}: cannot read a letter after `Answer:` in {item[:40]!r}")
                current.answer = a.group(2).lower()
                # "C. Some cultures..." keeps the prose after the letter; "B is not
                # as reliable..." has no period, so the letter is part of the
                # sentence and the whole remainder is kept, letter and all.
                rest = (a.group(4) if a.group(3) else a.group(1)).strip()
                current.explanation = rest if rest and rest.lower() != current.answer else None
            else:
                if current.answer is not None:
                    raise SeedError(f"{path.name}: question {current.number} has a choice after its `Answer:` line")
                current.choices.append(item)

    if not questions:
        raise SeedError(f"{path.name}: no questions found")
    for expected, question in enumerate(questions, start=1):
        if question.number != expected:
            raise SeedError(f"{path.name}: question numbering gap: expected {expected}, found {question.number}")
        if not 2 <= len(question.choices) <= 6:
            raise SeedError(f"{path.name}: question {question.number} has {len(question.choices)} choices; 2 to 6 are allowed")
        if question.answer is None:
            raise SeedError(f"{path.name}: question {question.number} has no `Answer:` line")
        if question.answer not in LETTERS[: len(question.choices)]:
            raise SeedError(
                f"{path.name}: question {question.number} answers {question.answer.upper()}, "
                f"outside its {len(question.choices)} choices"
            )

    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return Quiz(path=path, meta=meta, questions=questions, digest=digest)


def check_folder_unique(quiz: Quiz) -> None:
    for other in sorted(quiz.path.parent.glob("*.md")):
        if other.resolve() == quiz.path.resolve():
            continue
        try:
            meta, _ = split_front_matter(other.read_text(encoding="utf-8"), other)
        except SeedError:
            continue
        if str(meta.get("quiz_key", "")).strip() == quiz.key:
            raise SeedError(f"two files in {quiz.path.parent.name} carry quiz_key {quiz.key}: {quiz.path.name} and {other.name}")


def counts(quiz: Quiz) -> dict[str, int]:
    return {
        "questions": len(quiz.questions),
        "choices": sum(len(q.choices) for q in quiz.questions),
        "correct": sum(1 for q in quiz.questions if q.answer),
        "explanations": sum(1 for q in quiz.questions if q.explanation),
    }


# ---------------------------------------------------------------------------
# The leak gate
# ---------------------------------------------------------------------------

def gate_population(quiz: Quiz) -> list[str]:
    """Every stem, explanation and long choice, in raw and stripped forms."""
    out: list[str] = []
    seen: set[str] = set()

    def consider(text: str | None) -> None:
        if not text:
            return
        text = text.strip()
        if len(text) < SUBSTANTIAL_MIN_CHARS or len(text.split()) < SUBSTANTIAL_MIN_WORDS:
            return
        if text not in seen:
            seen.add(text)
            out.append(text)

    for q in quiz.questions:
        for item in [q.stem, q.explanation, *q.choices]:
            consider(item)
            consider(re.sub(r"[*_`\[\]]", "", item or ""))
    return out


def leak_gate(quiz: Quiz) -> int:
    population = gate_population(quiz)
    print(f"  leak gate: {len(population)} string(s) of {quiz.path.name} checked against the repo")
    if not population:
        raise SeedError(f"{quiz.path.name}: the leak gate has an empty population, so it would pass and prove nothing")
    hits: list[tuple[str, list[str]]] = []
    for text in population:
        found = repo_grep(text)
        if found:
            hits.append((text, found))
    if hits:
        detail = "\n".join(f"      {t[:70]!r} -> {', '.join(f)}" for t, f in hits[:10])
        raise SeedError(
            f"leak gate: {len(hits)} string(s) of {quiz.path.name} are already in the site repo's "
            f"working tree:\n{detail}\n    Remove them from the repo before seeding."
        )
    print(f"    no leak: {len(population)} string(s) absent from the repo's tracked and untracked files")
    return len(population)


# ---------------------------------------------------------------------------
# SQL
# ---------------------------------------------------------------------------

def lit(value) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def query(sql: str) -> list[dict]:
    """A READ as postgres, returning rows. Writes go through post_sql()."""
    import urllib.error
    import urllib.request

    secret = Path.home() / ".claude/secrets/obt-cdt-supabase.env"
    if not secret.exists():
        raise SeedError(f"no credentials at {secret}")
    env = {}
    for line in secret.read_text().split("\n"):
        if "=" in line and not line.strip().startswith("#"):
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip()
    ref = env.get("OBT_CDT_SUPABASE_PROJECT_REF", "")
    token = env.get("OBT_CDT_SUPABASE_ACCESS_TOKEN", "")
    if ref in FORBIDDEN_REFS:
        raise SeedError(f"REFUSED: {ref} is {FORBIDDEN_REFS[ref]}, a different product.")
    request = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{ref}/database/query",
        data=json.dumps({"query": sql}).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            # api.supabase.com answers urllib's default User-Agent with 403.
            "User-Agent": "obt-cdt-seed-review-quiz/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read().decode() or "[]")
    except urllib.error.HTTPError as exc:
        raise SeedError(f"management API {exc.code}: {exc.read().decode()[:400]}") from exc


def check_structure(quiz: Quiz) -> None:
    """Refusal 7: no question or choice added or removed once anyone has attempted."""
    attempts = query(f"select count(*)::int as n from public.quiz_attempt where quiz_key = {lit(quiz.key)}")[0]["n"]
    if attempts == 0:
        print(f"  attempts   : 0 on {quiz.key}, so the structure may change")
        return
    rows = query(
        "select qq.question_key, qc.choice_key from public.quiz_question qq "
        "join public.quiz_choice qc on qc.question_id = qq.id "
        f"where qq.quiz_key = {lit(quiz.key)}"
    )
    live = {(r["question_key"], r["choice_key"]) for r in rows}
    source = {(q.key, LETTERS[i]) for q in quiz.questions for i in range(len(q.choices))}
    if live != source:
        added = sorted(source - live)
        removed = sorted(live - source)
        raise SeedError(
            f"{quiz.key} has {attempts} attempt(s), and this source changes its structure "
            f"(added {added or 'none'}, removed {removed or 'none'}). Wording may change; the "
            "questions and choices may not, because stored attempts refer to them."
        )
    print(f"  attempts   : {attempts} on {quiz.key}; structure unchanged, wording may update")


def build_sql(quiz: Quiz) -> str:
    m = quiz.meta
    parts = [
        "-- scripts/seed_review_quiz.py, spec SITE-19. Generated; do not hand-edit.",
        "begin;",
        "insert into public.quiz (quiz_key, title, review_route, review_anchor, review_block, source_digest, active, updated_at)",
        f"values ({lit(quiz.key)}, {lit(str(m['title']).strip())}, {lit(str(m['review_route']).strip())}, "
        f"{lit(m.get('review_anchor'))}, {lit(m.get('review_block'))}, {lit(quiz.digest)}, true, now())",
        "on conflict (quiz_key) do update set title = excluded.title, review_route = excluded.review_route,",
        "  review_anchor = excluded.review_anchor, review_block = excluded.review_block,",
        "  source_digest = excluded.source_digest, active = true, updated_at = now();",
    ]
    keys = []
    for q in quiz.questions:
        keys.append(lit(q.key))
        parts.append(
            "insert into public.quiz_question (quiz_key, question_key, position, stem, explanation) values "
            f"({lit(quiz.key)}, {lit(q.key)}, {q.number}, {lit(q.stem)}, {lit(q.explanation)}) "
            "on conflict (quiz_key, question_key) do update set position = excluded.position, "
            "stem = excluded.stem, explanation = excluded.explanation;"
        )
        qid = f"(select id from public.quiz_question where quiz_key = {lit(quiz.key)} and question_key = {lit(q.key)})"
        # Clear the key first: the partial unique index allows one right choice
        # per question, and a changed answer would otherwise collide mid-update.
        parts.append(f"update public.quiz_choice set is_correct = false where question_id = {qid};")
        letters = []
        for i, label in enumerate(q.choices):
            letter = LETTERS[i]
            letters.append(lit(letter))
            parts.append(
                "insert into public.quiz_choice (question_id, choice_key, position, label, is_correct) values "
                f"({qid}, {lit(letter)}, {i + 1}, {lit(label)}, {lit(letter == q.answer)}) "
                "on conflict (question_id, choice_key) do update set position = excluded.position, "
                "label = excluded.label, is_correct = excluded.is_correct;"
            )
        parts.append(f"delete from public.quiz_choice where question_id = {qid} and choice_key not in ({', '.join(letters)});")
    parts.append(f"delete from public.quiz_question where quiz_key = {lit(quiz.key)} and question_key not in ({', '.join(keys)});")
    parts.append("commit;")
    return "\n".join(parts) + "\n"


def db_counts(key: str) -> dict[str, int]:
    return query(
        "select "
        f"(select count(*)::int from public.quiz_question where quiz_key = {lit(key)}) as questions, "
        "(select count(*)::int from public.quiz_choice c join public.quiz_question q on q.id = c.question_id "
        f" where q.quiz_key = {lit(key)}) as choices, "
        "(select count(*)::int from public.quiz_choice c join public.quiz_question q on q.id = c.question_id "
        f" where q.quiz_key = {lit(key)} and c.is_correct) as correct, "
        f"(select count(*)::int from public.quiz_question where quiz_key = {lit(key)} and explanation is not null) as explanations"
    )[0]


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

def self_test() -> int:
    """Criterion 14: the gate refuses a planted stem, and the gate is the reason."""
    words = ["river", "lantern", "harvest", "meadow", "copper", "willow", "granite", "orchard", "falcon", "ember"]
    tag = secrets.token_hex(6)

    def stem(n: int) -> str:
        pick = " ".join(secrets.choice(words) for _ in range(9))
        return f"Generated self-test stem {n} {tag} asks about {pick}?"

    lines = [
        "---",
        f"quiz_key: site19-selftest-{tag}",
        "title: Self-test quiz",
        "review_route: /members/self-test",
        "signed_off: false",
        "---",
        "",
    ]
    for n in range(1, 4):
        lines.append(f"{n}. {stem(n)}")
        for i in range(1, 5):
            lines.append(f"\t{i}. Option {i} for item {n}")
        lines.append("\t5. Answer: B.")
    with tempfile.TemporaryDirectory() as tmp:
        doc = Path(tmp) / "Self-Test-Quiz.md"
        doc.write_text("\n".join(lines) + "\n", encoding="utf-8")
        quiz = parse_quiz(doc)
        print(f"self-test: generated {doc.name} with {counts(quiz)['questions']} questions (no vault content)")

        # The clean half: the same gate passes when nothing is planted, so a
        # gate that refuses everything cannot pass this test.
        try:
            population = leak_gate(quiz)
        except SeedError as exc:
            print(f"SELF-TEST FAILED: the gate refused a clean generated quiz: {exc}")
            return 1

        plant = REPO / "scripts" / f".site19-selftest-plant-{tag}.txt"
        try:
            plant.write_text(f"pasted by the self-test: {quiz.questions[1].stem}\n", encoding="utf-8")
            try:
                leak_gate(quiz)
            except SeedError as exc:
                if "leak gate:" in str(exc) and plant.name in str(exc):
                    print(f"self-test: REFUSED as expected, naming {plant.name}; population {population}")
                    print("SELF-TEST PASSED")
                    return 0
                print(f"SELF-TEST FAILED: refused, but not by the gate naming the plant: {exc}")
                return 1
            print("SELF-TEST FAILED: the planted stem was NOT refused")
            return 1
        finally:
            plant.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", type=Path, help="one quiz file in the vault")
    ap.add_argument("--apply", action="store_true", help="write; the default is a dry run")
    ap.add_argument("--self-test", action="store_true", help="prove the leak gate refuses a planted stem")
    args = ap.parse_args()

    try:
        if args.self_test:
            return self_test()
        if not args.source:
            ap.error("--source is required (one quiz file per run)")
        if not args.source.exists():
            raise SeedError(f"no such file: {args.source}")

        quiz = parse_quiz(args.source)
        check_folder_unique(quiz)
        c = counts(quiz)
        print(f"seed_review_quiz: {quiz.key}")
        print(f"  source     : {quiz.path}")
        print(f"  digest     : {quiz.digest[:16]}…")
        print(f"  parsed     : questions={c['questions']} choices={c['choices']} "
              f"correct={c['correct']} explanations={c['explanations']}")
        leak_gate(quiz)

        if not args.apply:
            print("\n  DRY RUN. Re-run with --apply to write.")
            return 0
        if quiz.meta.get("signed_off") is not True:
            raise SeedError(f"{quiz.path.name}: signed_off is not true. Joshua signs the quiz text off before it is seeded.")

        check_structure(quiz)
        post_sql(build_sql(quiz))
        d = db_counts(quiz.key)
        print(f"  database   : questions={d['questions']} choices={d['choices']} "
              f"correct={d['correct']} explanations={d['explanations']}")
        if d != c:
            raise SeedError(f"the database counts {d} do not equal the parsed counts {c}")
        print("  applied; database counts equal the parsed counts")
        return 0
    except SeedError as exc:
        print(f"\nREFUSED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
