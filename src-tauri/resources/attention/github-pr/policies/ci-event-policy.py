#!/usr/bin/env python3
"""Classify whether a PR check-snapshot transition is worth waking an agent."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

ACTIONABLE_BUCKETS = {"fail", "cancel"}
GREEN_BUCKETS = {"pass", "skipping"}


def read_checks(path: Path) -> list[tuple[str, ...]]:
    rows: list[tuple[str, ...]] = []
    for raw in path.read_text().splitlines():
        fields = tuple(raw.split("\t"))
        if fields and fields[0] == "check":
            rows.append(fields)
    return rows


def bucket_counts(rows: list[tuple[str, ...]]) -> Counter[str]:
    return Counter(row[2] if len(row) > 2 else "unknown" for row in rows)


def actionable_identity(rows: list[tuple[str, ...]]) -> set[tuple[str, str, str]]:
    result: set[tuple[str, str, str]] = set()
    for row in rows:
        bucket = row[2] if len(row) > 2 else "unknown"
        if bucket in ACTIONABLE_BUCKETS:
            name = row[1] if len(row) > 1 else "unknown"
            state = row[3] if len(row) > 3 else "unknown"
            result.add((name, bucket, state))
    return result


def green_completion_is_actionable(draft_state: str, review_decision: str) -> bool:
    return draft_state == "draft" or review_decision == "APPROVED"


def classify(
    old_rows: list[tuple[str, ...]],
    new_rows: list[tuple[str, ...]],
    *,
    draft_state: str = "draft",
    review_decision: str = "UNKNOWN",
) -> dict[str, object]:
    old_counts = bucket_counts(old_rows)
    new_counts = bucket_counts(new_rows)
    old_pending = old_counts["pending"]
    new_pending = new_counts["pending"]
    old_actionable = actionable_identity(old_rows)
    new_actionable = actionable_identity(new_rows)
    terminal_green = bool(new_rows) and all(
        (row[2] if len(row) > 2 else "unknown") in GREEN_BUCKETS for row in new_rows
    )

    added_actionable = new_actionable - old_actionable
    if added_actionable:
        return {"emit": True, "kind": "failure", "reason": "a check became failing or cancelled"}
    if old_actionable and not new_actionable and new_pending == 0:
        if terminal_green and not green_completion_is_actionable(draft_state, review_decision):
            return {
                "emit": False,
                "kind": "waiting-for-approval",
                "reason": "CI is green but the ready PR is not approved",
            }
        return {"emit": True, "kind": "recovered", "reason": "failing checks recovered"}
    if old_pending > 0 and new_pending == 0:
        if terminal_green and not green_completion_is_actionable(draft_state, review_decision):
            return {
                "emit": False,
                "kind": "waiting-for-approval",
                "reason": "CI is green but the ready PR is not approved",
            }
        return {"emit": True, "kind": "completed", "reason": "all pending checks finished"}
    return {"emit": False, "kind": "noise", "reason": "only non-actionable check progress changed"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("old", type=Path)
    parser.add_argument("new", type=Path)
    parser.add_argument("--draft-state", choices=("draft", "ready"), default="draft")
    parser.add_argument("--review-decision", default="UNKNOWN")
    parser.add_argument("--exit-code", action="store_true", help="exit 0 for emit, 1 for suppress")
    args = parser.parse_args()
    decision = classify(
        read_checks(args.old),
        read_checks(args.new),
        draft_state=args.draft_state,
        review_decision=args.review_decision,
    )
    print(json.dumps(decision, separators=(",", ":")))
    if args.exit_code:
        return 0 if decision["emit"] else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
