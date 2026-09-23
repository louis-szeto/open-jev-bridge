"""Run all optional-adapter offline tests and save machine-readable evidence."""
import json
import platform
from pathlib import Path
import sys
import unittest

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
suite = unittest.defaultTestLoader.discover(str(root / "tests/python"))
result = unittest.TextTestRunner(verbosity=2).run(suite)
summary = {"python": platform.python_version(), "tests": result.testsRun,
           "failed": len(result.failures), "errors": len(result.errors),
           "skipped": len(result.skipped),
           "passed": result.testsRun - len(result.failures) - len(result.errors) - len(result.skipped),
           "fixture_backend": True, "real_laya_inference": "NOT_EXECUTED",
           "all_green": result.wasSuccessful() and not result.skipped}
(root / "reports").mkdir(exist_ok=True)
(root / "reports/adapter-validation.json").write_text(json.dumps(summary, indent=2) + "\n")
sys.exit(0 if summary["all_green"] else 1)
