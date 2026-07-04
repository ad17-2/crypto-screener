import json
import unittest
from pathlib import Path

import tomllib


class PackagingRailwayTests(unittest.TestCase):
    def test_runtime_dependencies_are_mirrored_for_railway_requirements_install(self):
        pyproject = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
        project_deps = {
            dependency.split(">=", 1)[0].split("<", 1)[0].lower() for dependency in pyproject["project"]["dependencies"]
        }
        requirements = {
            line.split(">=", 1)[0].split("<", 1)[0].lower()
            for line in Path("requirements.txt").read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.startswith("#")
        }

        self.assertEqual(requirements, project_deps)

    def test_python_runtime_pin_matches_github_actions(self):
        self.assertEqual(Path(".python-version").read_text(encoding="utf-8").strip(), "3.11")
        workflow = Path(".github/workflows/deploy-railway.yml").read_text(encoding="utf-8")

        self.assertIn('python-version: "3.11"', workflow)

    def test_railway_start_command_and_healthcheck_contract_stay_stable(self):
        railway = json.loads(Path("railway.json").read_text(encoding="utf-8"))

        self.assertEqual(railway["deploy"]["startCommand"], "python -m crypto_screener.dashboard")
        self.assertEqual(railway["deploy"]["healthcheckPath"], "/health")

    def test_packaging_includes_dashboard_static_assets(self):
        pyproject = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))

        self.assertIn("dashboard_static/*", pyproject["tool"]["setuptools"]["package-data"]["crypto_screener"])

    def test_github_actions_quality_gate_installs_deps_and_runs_static_checks(self):
        workflow = Path(".github/workflows/deploy-railway.yml").read_text(encoding="utf-8")

        self.assertIn('python -m pip install -e ".[dev]"', workflow)
        self.assertIn("python -m ruff check .", workflow)
        self.assertIn("python -m ruff format --check .", workflow)
        self.assertIn("python -m mypy crypto_screener", workflow)


if __name__ == "__main__":
    unittest.main()
