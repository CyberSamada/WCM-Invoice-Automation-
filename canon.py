#!/usr/bin/env python3
"""canon.py -- move a fact between repositories without a person in the middle.

    python3 canon.py status      what this repo owns, and what it imports
    python3 canon.py check       exit 1 if an import is behind its owner
    python3 canon.py pull        re-import everything, and stamp it

Why this exists. Three repositories act on the same world: the Procore MCP
server, WCM Invoice Automation, and WCM Mission Control. Each one learned
things the other two needed. Nothing carried a fact across, so Ahmed
carried it, by hand, as prose he pasted. The `requisitions` attachment
field was learned twice, in two repositories, days apart, because of that.

The rule this file enforces is simple. **Every fact has exactly one owner.**
A consumer never edits its copy. It re-imports it, and records the commit
it came from. When the owner moves ahead, `check` fails and says so.

That is a lockfile, for facts instead of packages.

`canon.json` beside this file says what this repo owns and what it imports.
This script is deliberately identical in all three repositories, so the
same command means the same thing wherever a session opens.

No new repository, no server, no credential. It reads git, which every
session already has.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "canon.json"

GREEN, RED, YELLOW, DIM, OFF = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"


class CanonError(Exception):
    """Something is wrong with canon.json, or with reaching an owner."""


def run(args: list[str], cwd: Path | None = None) -> str:
    out = subprocess.run(
        args, cwd=cwd, capture_output=True, text=True, check=False
    )
    if out.returncode != 0:
        raise CanonError(f"{' '.join(args[:4])} failed: {out.stderr.strip()[:300]}")
    return out.stdout


def load() -> dict:
    if not CONFIG.exists():
        raise CanonError(f"No canon.json at {CONFIG}.")
    return json.loads(CONFIG.read_text(encoding="utf-8"))


def save(config: dict) -> None:
    CONFIG.write_text(
        json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def url_for(repo: str) -> str:
    return f"https://github.com/{repo}.git"


def sibling(repo: str) -> Path | None:
    """A clone of the owner sitting next to this one.

    Sessions that work more than one of these repositories have all of them
    checked out side by side. Reading the owner from there is faster than a
    clone, and it still asks the remote for the true commit, so it can
    never report a stale local branch as current.
    """
    name = repo.split("/")[-1]
    for candidate in (ROOT.parent / name, ROOT.parent / name.lower()):
        if (candidate / ".git").is_dir():
            return candidate
    return None


def head_sha(repo: str, ref: str) -> str:
    """The owner's current commit for that ref. One network call, no clone."""
    out = run(["git", "ls-remote", url_for(repo), ref])
    if not out.strip():
        raise CanonError(f"{repo} has no ref named {ref}.")
    return out.split()[0]


def read_remote_file(repo: str, ref: str, path: str) -> str:
    """The file's content at the owner's current commit."""
    missing = (
        f"{repo}@{ref} has no file at {path} yet.\n"
        f"  The owner has not published it on that branch. If the change that "
        f"adds it is still an open pull request, merge it first, then pull again."
    )

    local = sibling(repo)
    if local is not None:
        run(["git", "fetch", "-q", "origin", ref], cwd=local)
        try:
            return run(["git", "show", f"FETCH_HEAD:{path}"], cwd=local)
        except CanonError as exc:
            if "exists on disk" in str(exc) or "does not exist" in str(exc):
                raise CanonError(missing) from exc
            raise

    with tempfile.TemporaryDirectory() as tmp:
        run([
            "git", "clone", "--depth", "1", "--branch", ref,
            "--filter=blob:none", "--sparse", "-q", url_for(repo), tmp,
        ])
        run(["git", "sparse-checkout", "set", "--no-cone", path], cwd=Path(tmp))
        target = Path(tmp) / path
        if not target.exists():
            raise CanonError(missing)
        return target.read_text(encoding="utf-8")


def cmd_status(config: dict) -> int:
    repo = config.get("repo", "?")
    print(f"{DIM}repo{OFF} {repo}\n")

    owns = config.get("owns", {})
    print(f"{DIM}OWNS{OFF}")
    if not owns:
        print("  nothing\n")
    for name, spec in owns.items():
        exists = (ROOT / spec["path"]).exists()
        mark = f"{GREEN}present{OFF}" if exists else f"{RED}MISSING{OFF}"
        print(f"  {name:22} {spec['path']:38} {mark}")
        if spec.get("build"):
            print(f"  {'':22} {DIM}build: {spec['build']}{OFF}")
    print()

    imports = config.get("imports", {})
    print(f"{DIM}IMPORTS{OFF}")
    if not imports:
        print("  nothing")
        return 0
    for name, spec in imports.items():
        stamped = spec.get("imported_sha")
        try:
            current = head_sha(spec["repo"], spec["ref"])
        except CanonError as exc:
            print(f"  {name:22} {YELLOW}cannot reach owner{OFF} {DIM}{exc}{OFF}")
            continue
        if stamped == current:
            state = f"{GREEN}current{OFF}"
        elif stamped is None:
            state = f"{RED}never imported{OFF}"
        else:
            state = f"{RED}BEHIND{OFF} {DIM}{stamped[:8]} -> {current[:8]}{OFF}"
        print(f"  {name:22} {spec['local_path']:38} {state}")
        print(f"  {'':22} {DIM}from {spec['repo']}@{spec['ref']}{OFF}")
    return 0


def cmd_check(config: dict) -> int:
    behind: list[str] = []
    unreachable: list[str] = []
    for name, spec in config.get("imports", {}).items():
        try:
            current = head_sha(spec["repo"], spec["ref"])
        except CanonError:
            unreachable.append(name)
            continue
        if spec.get("imported_sha") != current:
            behind.append(name)

    for name in unreachable:
        print(f"{YELLOW}?{OFF} {name}: cannot reach the owner. Not treated as a failure.")
    if behind:
        for name in behind:
            spec = config["imports"][name]
            print(
                f"{RED}x{OFF} {name} is behind {spec['repo']}@{spec['ref']}. "
                f"Run: python3 canon.py pull {name}"
            )
        return 1
    print(f"{GREEN}ok{OFF} every imported fact matches its owner.")
    return 0


def cmd_pull(config: dict, only: str | None) -> int:
    imports = config.get("imports", {})
    if only and only not in imports:
        raise CanonError(f"This repo does not import {only!r}.")
    names = [only] if only else list(imports)
    if not names:
        print("Nothing to import.")
        return 0

    changed = False
    for name in names:
        spec = imports[name]
        sha = head_sha(spec["repo"], spec["ref"])
        content = read_remote_file(spec["repo"], spec["ref"], spec["remote_path"])
        target = ROOT / spec["local_path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        was = target.read_text(encoding="utf-8") if target.exists() else None
        target.write_text(content, encoding="utf-8")
        spec["imported_sha"] = sha
        spec["imported_at"] = run(["git", "log", "-1", "--format=%cs"], cwd=ROOT).strip()
        if was != content:
            changed = True
            print(f"{GREEN}updated{OFF} {spec['local_path']} {DIM}from {sha[:8]}{OFF}")
        else:
            print(f"{DIM}unchanged{OFF} {spec['local_path']} {DIM}at {sha[:8]}{OFF}")

    save(config)
    if changed:
        print("\nCommit the imported files together with canon.json.")
    return 0


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else "status"
    try:
        config = load()
        if command == "status":
            return cmd_status(config)
        if command == "check":
            return cmd_check(config)
        if command == "pull":
            return cmd_pull(config, argv[2] if len(argv) > 2 else None)
    except CanonError as exc:
        print(f"{RED}canon: {exc}{OFF}", file=sys.stderr)
        return 2
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
