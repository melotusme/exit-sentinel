import importlib.util
import plistlib
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("shadowrocket_nodes", Path(__file__).parents[1] / "src-tauri/src/shadowrocket_nodes.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class NodeIdentityTest(unittest.TestCase):
    def test_only_identity_fields_leave_the_archive(self):
        objects = ["$null", "日本", "proxy.example", "443", "VLESS", "PRIVATE_PASSWORD",
                   {"uuid": "PRIVATE_UUID", "title": plistlib.UID(1), "host": plistlib.UID(2),
                    "port": plistlib.UID(3), "type": plistlib.UID(4), "password": plistlib.UID(5)},
                   {"uuid": "sub", "host": "https://example.com/PRIVATE_SUBSCRIPTION", "port": "443", "type": "Subscribe"}]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ServerManager"
            path.write_bytes(plistlib.dumps({"$objects": objects}, fmt=plistlib.FMT_BINARY))
            result = module.identities(path)
        self.assertEqual(result['proxies'][0]['name'], '日本')
        self.assertEqual(result['proxies'][0]['server'], 'proxy.example')
        self.assertEqual(result['proxies'][0]['port'], 443)
        self.assertNotIn("PRIVATE_", str(result))

    def test_subscription_labels_are_preserved_without_subscription_urls(self):
        objects = ['$null',
            {'uuid':'sub-a','type':'Subscribe','title':'机场甲｜https://private.example/PRIVATE_TOKEN','host':'https://private.example/PRIVATE_TOKEN'},
            {'uuid':'sub-b','type':'Subscribe','title':'机场乙','host':'https://other.example/PRIVATE_TOKEN'},
            {'uuid':'n1','type':'VLESS','title':'US01','host':'a.example','port':443,'data':'https://private.example/PRIVATE_TOKEN'},
            {'uuid':'n2','type':'VLESS','title':'US01','host':'b.example','port':443,'data':'https://other.example/PRIVATE_TOKEN'}]
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'ServerManager';path.write_bytes(plistlib.dumps({'$objects':objects}))
            result=module.identities(path)['proxies']
        self.assertEqual([n['sentinel_provider'] for n in result], ['机场甲','机场乙'])
        self.assertNotEqual(result[0]['sentinel_provider_id'], result[1]['sentinel_provider_id'])
        self.assertNotIn('PRIVATE_', str(result))


if __name__ == "__main__":
    unittest.main()
