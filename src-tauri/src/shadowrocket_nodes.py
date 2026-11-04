"""Read Shadowrocket node identities only. Never emit raw archives or credentials."""
import json
import plistlib
import hashlib
import re
from pathlib import Path


def identities(path):
    if path.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("archive too large")
    objects = plistlib.loads(path.read_bytes())["$objects"]

    def field(value, depth=0):
        if depth > 20:
            return ""
        if isinstance(value, plistlib.UID):
            return field(objects[value.data], depth + 1)
        if isinstance(value, dict) and "NS.string" in value:
            return field(value["NS.string"], depth + 1)
        return value if isinstance(value, (str, int)) else ""

    subscriptions = {}
    for value in objects:
        if not isinstance(value, dict) or str(field(value.get("type", ""))).lower() not in ("subscribe", "subscription"):
            continue
        label = re.sub(r'https?://\S+', '', str(field(value.get('title', '')))).strip(' |｜·')
        label = ''.join(c for c in label if c.isprintable())[:100] or '未命名订阅'
        source_id = hashlib.sha256(str(field(value.get('uuid', ''))).encode()).hexdigest()
        subscriptions[str(field(value.get('host', '')))] = (label, source_id)
    nodes = []
    for value in objects:
        if not isinstance(value, dict) or "uuid" not in value or "host" not in value:
            continue
        kind = str(field(value.get("type", ""))).lower()
        if kind in ("subscribe", "subscription", "group", ""):
            continue
        host = str(field(value.get("host", "")))
        if any(s in host for s in ("://", "@", "?", "/")):
            continue
        try:
            port = int(field(value.get("port", 0)))
        except (TypeError, ValueError):
            continue
        if not 1 <= port <= 65535:
            continue
        source = subscriptions.get(str(field(value.get('data', ''))))
        nodes.append({"name": str(field(value.get("title", ""))) or host,
                      "server": host, "port": port, "type": kind,
                      "sentinel_provider": source[0] if source else '本地节点 / 来源未确认',
                      "sentinel_provider_id": source[1] if source else ''})
    return {"proxies": nodes}


if __name__ == "__main__":
    try:
        path = Path.home() / "Library/Group Containers/group.com.liguangming.Shadowrocket/ServerManager"
        print(json.dumps(identities(path), ensure_ascii=False))
    except PermissionError:
        print(json.dumps({"error": "permission_denied"}))
    except FileNotFoundError:
        print(json.dumps({"error": "missing"}))
    except Exception:
        print(json.dumps({"error": "unreadable"}))
