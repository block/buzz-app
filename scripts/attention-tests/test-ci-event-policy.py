#!/usr/bin/env python3
import sys
sys.dont_write_bytecode = True
import importlib.util
import pathlib
import tempfile

script = pathlib.Path(__file__).resolve().parents[2] / "src-tauri/resources/attention/github-pr/policies/ci-event-policy.py"
spec = importlib.util.spec_from_file_location("ci_event_policy", script)
module = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(module)


def rows(*pairs: tuple[str, str]):
    return [("check", name, bucket, bucket.upper(), bucket.upper(), "") for name, bucket in pairs]


def expect(old, new, emit: bool, kind: str):
    result = module.classify(rows(*old), rows(*new))
    assert result["emit"] is emit, result
    assert result["kind"] == kind, result


def expect_context(old, new, draft_state: str, review_decision: str, emit: bool, kind: str):
    result = module.classify(
        rows(*old),
        rows(*new),
        draft_state=draft_state,
        review_decision=review_decision,
    )
    assert result["emit"] is emit, result
    assert result["kind"] == kind, result


expect([], [("build", "pending")], False, "noise")
expect(
    [("build", "pass")],
    [("build", "pending")],
    False,
    "noise",
)
expect(
    [("build", "pending"), ("security", "pending"), ("lint", "pass")],
    [("build", "pending"), ("security", "pending"), ("lint", "pass"), ("types", "pass")],
    False,
    "noise",
)
expect(
    [("build", "pending"), ("security", "pending")],
    [("security", "pending"), ("build", "pass")],
    False,
    "noise",
)
expect(
    [("build", "pending"), ("security", "pending")],
    [("security", "pending"), ("build", "fail")],
    True,
    "failure",
)
expect(
    [("build", "fail"), ("security", "pending")],
    [("build", "fail"), ("security", "fail")],
    True,
    "failure",
)
expect(
    [("build", "fail"), ("security", "pending")],
    [("build", "fail"), ("security", "pass")],
    True,
    "completed",
)
expect(
    [("build", "pending"), ("security", "pending")],
    [("build", "pass"), ("security", "pass")],
    True,
    "completed",
)
expect(
    [("build", "fail")],
    [("build", "pending")],
    False,
    "noise",
)
expect(
    [("build", "fail")],
    [("build", "pass")],
    True,
    "recovered",
)
expect(
    [("build", "pass")],
    [("build", "pass"), ("lint", "pass")],
    False,
    "noise",
)
expect_context(
    [("build", "pending")],
    [("build", "pass")],
    "draft",
    "UNKNOWN",
    True,
    "completed",
)
expect_context(
    [("build", "pending")],
    [("build", "pass")],
    "ready",
    "REVIEW_REQUIRED",
    False,
    "waiting-for-approval",
)
expect_context(
    [("build", "pending")],
    [("build", "pass")],
    "ready",
    "CHANGES_REQUESTED",
    False,
    "waiting-for-approval",
)
expect_context(
    [("build", "pending")],
    [("build", "pass")],
    "ready",
    "APPROVED",
    True,
    "completed",
)
expect_context(
    [("build", "fail")],
    [("build", "pass")],
    "ready",
    "REVIEW_REQUIRED",
    False,
    "waiting-for-approval",
)
print("ci-event-policy tests passed")
