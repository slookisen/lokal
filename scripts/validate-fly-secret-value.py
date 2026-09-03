#!/usr/bin/env python3
"""Pre-write sanity check for a value about to be imported as a Fly app secret.

Run by .github/workflows/fly-secrets.yml BEFORE `flyctl secrets import`, so a
malformed value is rejected instead of landing in production. Both failure modes
below actually happened on 2026-09-03 while activating FIRE_ROUTINES, and each
was invisible until the next dispatcher tick ~10 minutes later:

  1. The template's `"token":"TOKEN"` placeholder was pasted verbatim. It is
     valid JSON and passes the app's own parse (parseRoutines only checks that
     `trig`/`token` are strings), so `/admin/loop-dispatch` happily listed all
     six routines — and every `/fire` call returned HTTP 401.
  2. The GitHub secret held the whole line `FIRE_ROUTINES={...}` instead of just
     `{...}`. The workflow adds the `NAME=` prefix itself, so the stored value
     began with the literal text `FIRE_ROUTINES=`, no longer parsed as JSON, and
     the routine map went empty — worse than before the change.

This script is the single place that decides what reaches Fly: it validates the
value AND writes the exact `NAME=VALUE` line the workflow then feeds to flyctl
on stdin, so what was checked is byte-for-byte what gets imported.

Environment:
  SECRET_NAME      required, UPPER_SNAKE_CASE
  SECRET_VALUE     required, the raw GitHub secret
  SECRET_LINE_OUT  optional, path to write the validated `NAME=VALUE\\n` line to

Prints GitHub-Actions annotations and exits non-zero on rejection. Never prints
the value — only its length, and, for a placeholder hit, the offending
placeholder itself (which by definition is not a real credential).
"""

import json
import os
import re
import sys

NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")

# Values a human leaves behind when they copy a template without filling it in.
# Anchored: a real credential never equals one of these outright.
PLACEHOLDER = re.compile(
    r"^(?:token|value|secret|changeme|placeholder|todo|tbd|x+|\.{3}|<[^>]*>|"
    r"your[-_ ]?\w*|paste[-_ ]?\w*)$",
    re.IGNORECASE,
)

# Keys whose values are credentials, so a suspiciously short one is a filled-in
# placeholder rather than a real secret (an sk-ant-oat01 token is ~108 chars).
CREDENTIAL_KEY = re.compile(r"token|secret|key|password|passwd|credential", re.IGNORECASE)
MIN_CREDENTIAL_LEN = 20


def fail(name: str, msg: str) -> None:
    print(f"::error::{name}: {msg} — nothing was written to Fly.")
    sys.exit(1)


def walk(node, name: str, key_hint: str = "") -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            walk(value, name, key)
    elif isinstance(node, list):
        for value in node:
            walk(value, name, key_hint)
    elif isinstance(node, str):
        stripped = node.strip()
        if PLACEHOLDER.match(stripped):
            where = f'field "{key_hint}"' if key_hint else "a value"
            fail(name, f'{where} still holds the placeholder "{stripped}"')
        if key_hint and CREDENTIAL_KEY.search(key_hint) and len(stripped) < MIN_CREDENTIAL_LEN:
            fail(
                name,
                f'field "{key_hint}" holds a {len(stripped)}-character value, too short to '
                f"be a real credential (expected >= {MIN_CREDENTIAL_LEN})",
            )


def main() -> int:
    name = os.environ.get("SECRET_NAME", "")
    value = os.environ.get("SECRET_VALUE", "")

    if not NAME_RE.match(name):
        print(f"::error::Invalid secret name {name!r} (expected UPPER_SNAKE_CASE)")
        return 1
    if not value:
        fail(name, "value is missing or empty")

    # `flyctl secrets import` is line-based: a NAME=VALUE per line.
    if "\n" in value or "\r" in value:
        fail(name, "value contains a line break; put it on one line")

    # The workflow adds the `NAME=` prefix itself. A value that already carries
    # one would be stored with the prefix as part of the secret (incident 2).
    prefix = f"{name}="
    if value.startswith(prefix):
        print(
            f"::warning::{name}: value started with a redundant {prefix!r} prefix — "
            "stripping it. The GitHub secret should hold the VALUE only."
        )
        value = value[len(prefix) :]
        if not value:
            fail(name, f"value was only the {prefix!r} prefix, with nothing after it")

    # Only structured values get the JSON treatment; a plain flag such as
    # RETENTION_JOB_ENABLED=true passes through untouched.
    if value.lstrip()[:1] in "{[":
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError as err:
            fail(name, f"looks like JSON but does not parse ({err})")
        walk(parsed, name)

    out_path = os.environ.get("SECRET_LINE_OUT")
    if out_path:
        # 0600 before writing: the runner is ephemeral and single-tenant, but the
        # value should not be world-readable even for the seconds it exists.
        fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")

    print(f"{name}: value validated ({len(value)} chars)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
