import runpy
import tempfile
import unittest
from pathlib import Path

policy = runpy.run_path(str(Path(__file__).resolve().parents[2] / "src-tauri/resources/attention/buzz-attention-policy"))

class PolicyTests(unittest.TestCase):
    def test_missing_invalid_and_empty_policies_withhold_comments(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "policy.json"
            self.assertFalse(policy["read"](path)["configured"])
            path.write_text("invalid")
            self.assertFalse(policy["read"](path)["configured"])
            empty = dict(version=1, trustedOrganizations=[], trustedAuthors=[], ignoredAuthors=[])
            self.assertFalse(policy["write"](path, empty)["configured"])

    def test_round_trip_and_rejected_write_preserves_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "policy.json"
            value = dict(version=1, trustedOrganizations=["example"], trustedAuthors=["reviewer[bot]"], ignoredAuthors=[])
            self.assertEqual(policy["write"](path, value)["policy"], value)
            before = path.read_bytes()
            with self.assertRaises(ValueError):
                policy["write"](path, dict(value, trustedAuthors=["$(command)"]))
            self.assertEqual(path.read_bytes(), before)

unittest.main()
