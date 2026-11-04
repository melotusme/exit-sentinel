import importlib.util
import json
import plistlib
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("snapshot", Path(__file__).resolve().parents[1] / "src-tauri/src/shadowrocket_snapshot.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SnapshotTests(unittest.TestCase):
    def test_actual_connections_override_stale_config_and_keep_service_separate(self):
        lines = '''[17:55:30.735] tcp stream <1> proxy lookup host => gemini.google.com:443 server => AnyTLS policy => 亚特兰大01 group => US手动选择
[17:55:31.735] tcp stream <2> proxy lookup host => claude.ai:443 server => Vmess policy => PROXY group => 主代理
[17:55:32.735] tcp stream <3> proxy lookup host => unrelated.googleapis.com:443 server => AnyTLS policy => Other group => Google
[17:55:33.735] tcp stream <4> proxy lookup host => evilclaude.ai:443 server => Vmess policy => Wrong group => 主代理'''
        claude = module.parse_connection_lines(lines, 'claude.ai', '20261104')
        gemini = module.parse_connection_lines(lines, 'gemini.google.com', '20261104')
        self.assertEqual(claude['policy'], 'PROXY')
        self.assertEqual(gemini['policy'], '亚特兰大01')
        self.assertEqual(gemini['group'], 'US手动选择')
        self.assertIn('17:55:30', gemini['observed_at'])
        self.assertIsNone(module.parse_connection_lines(lines, 'www.google.com', '20261104'))

    def test_nested_selection_and_automatic_groups(self):
        groups = module.parse_groups([("Claude", "select,主代理"), ("主代理", "select,PROXY"), ("Google", "select,Claude,policy-select-name=自动"), ("自动", "url-test,Node-A")])
        chain, node, _ = module.resolve_chain(groups, "CLAUDE", "Node-A")
        self.assertEqual(chain, ["Claude", "主代理", "PROXY", "Node-A"])
        self.assertEqual(node, "Node-A")
        self.assertEqual(module.resolve_chain(groups, "GOOGLE", "Node-A")[1], "")
        cycle = module.parse_groups([("A", "select,B"), ("B", "select,A")])
        self.assertIn("循环", module.resolve_chain(cycle, "A", "Node-A")[2])

    def test_metadata_only_output_and_changed_config_changes_fingerprint(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            original = module.GROUP, module.DATABASES
            module.GROUP, module.DATABASES = base, base / "databases"
            module.DATABASES.mkdir()
            (base / "Library/Preferences").mkdir(parents=True)
            prefs = {"group.com.liguangming." + k: v for k, v in {"CurrentRuleFileName": "test.db", "GlobalRoutingMethod": "Config", "SelectedServerName": "Node-A", "SelectedServerUUID": "uuid-a"}.items()}
            (base / "Library/Preferences/group.com.liguangming.Shadowrocket.plist").write_bytes(plistlib.dumps(prefs))
            objects = ["$null", {"title": "Node-A", "host": "8.8.8.8", "uuid": "uuid-a", "password": "PRIVATE_PASSWORD", "privateKey": "PRIVATE_KEY", "data": "https://subscription.invalid/?token=PRIVATE_TOKEN"}]
            (base / "ServerManager").write_bytes(plistlib.dumps({"$objects": objects}))
            db = sqlite3.connect(str(module.DATABASES / "test.db"))
            db.execute("create virtual table config using fts3(section,name,value,option)")
            db.execute("insert into config values('proxygroup','Claude','select,PROXY','')")
            db.execute("insert into config values('rule','DOMAIN-SUFFIX','claude.ai','CLAUDE')")
            db.commit()
            try:
                result = module.snapshot("claude")
                self.assertEqual(result["node_name"], "Node-A")
                self.assertEqual(result["config"], "test.conf")
                serialized = json.dumps(result)
                for secret in ["PRIVATE_PASSWORD", "PRIVATE_KEY", "PRIVATE_TOKEN"]:
                    self.assertNotIn(secret, serialized)
                db.execute("update config set value='select,DIRECT' where section='proxygroup'")
                db.commit()
                self.assertNotEqual(result["fingerprint"], module.snapshot("claude")["fingerprint"])
            finally:
                db.close()
                module.GROUP, module.DATABASES = original


if __name__ == "__main__":
    unittest.main()
