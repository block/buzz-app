#!/usr/bin/env python3
"""Read Monitor registrations for Attention; archive only acknowledged snapshots."""
import argparse
import hashlib
import json
from pathlib import Path
import sys


def parse(path):
    raw = path.read_bytes()
    saved = json.loads(raw)
    parser = argparse.ArgumentParser()
    for name in ("channel", "thread", "name", "title", "instructions", "batch-window"):
        parser.add_argument("--" + name)
    parser.add_argument("--mention", action="append", required=True)
    parser.add_argument("--foreground", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(saved["argv"])
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        raise ValueError("Missing producer command")
    return {"file": path.name, "signature": hashlib.sha256(raw).hexdigest(),
            "agents": args.mention, "channel": args.channel, "root": args.thread,
            "name": args.name or path.stem, "title": args.title or path.stem,
            "instructions": args.instructions or "Report meaningful changes from this command.",
            "command": command, "cwd": saved["cwd"]}


def main(folder, args):
    if args:
        if len(args) != 3 or args[0] not in ("archive", "archive-wake") or Path(args[1]).name != args[1]:
            raise ValueError("Invalid acknowledgement")
        path = (folder.parent / "wakes" if args[0] == "archive-wake" else folder) / args[1]
        if hashlib.sha256(path.read_bytes()).hexdigest() != args[2]:
            raise ValueError("Registration changed during migration")
        # Keep the original as recovery evidence, outside the legacy *.json scan.
        path.rename(path.with_suffix(".migrated"))
        return
    result = []
    for path in sorted(folder.glob("*.json")):
        try:
            if path.stat().st_size > 1024 * 1024:
                raise ValueError("Registration is larger than 1 MiB")
            result.append(parse(path))
        except (OSError, ValueError, KeyError, TypeError, SystemExit) as error:
            print(f"Attention could not migrate {path.name}: {error}", file=sys.stderr)
    for path in sorted((folder.parent / "wakes").glob("*.json")):
        try:
            raw = path.read_bytes()
            if len(raw) > 1024 * 1024:
                raise ValueError("Wake is larger than 1 MiB")
            result.append({"file": path.name, "signature": hashlib.sha256(raw).hexdigest(), "wake": json.loads(raw)})
        except (OSError, ValueError) as error:
            print(f"Attention kept legacy wake {path.name}: {error}", file=sys.stderr)
    print(json.dumps(result))


if __name__ == "__main__":
    main(Path.home() / ".local/state/buzz-monitor/monitors", sys.argv[1:])
