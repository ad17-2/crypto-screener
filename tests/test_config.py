import tempfile
import unittest
from pathlib import Path

from pydantic import ValidationError

from crypto_screener.config import load_config


class ConfigTests(unittest.TestCase):
    def test_default_config_validates_and_round_trips_to_runtime_dict(self):
        config = load_config(Path("config/default.json"))
        runtime = config.to_runtime_dict()

        self.assertEqual(runtime["version"], 2)
        self.assertEqual(runtime["providers"]["coinglass"]["api_key_env"], "COINGLASS_API_KEY")
        self.assertEqual(runtime["report"]["limit"], 12)
        self.assertIn("technical_indicators", runtime["providers"]["coinglass"])

    def test_config_rejects_unknown_keys(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = Path(tmpdir) / "bad.json"
            config_path.write_text('{"version": 2, "unknown": true}', encoding="utf-8")

            with self.assertRaises(ValidationError):
                load_config(config_path)


if __name__ == "__main__":
    unittest.main()
