"""Read only Shadowrocket routing metadata. Never emit credentials or subscription URLs."""
import hashlib
import json
import plistlib
import sqlite3
import sys
from pathlib import Path

GROUP = Path.home() / "Library/Group Containers/group.com.liguangming.Shadowrocket"
DATABASES = Path.home() / "Library/Containers/com.liguangming.Shadowrocket/Data/Documents/Databases"


def archive(blob):
    value = plistlib.loads(blob)
    objects = value.get("$objects", [])

    def resolve(item, depth=0):
        if depth > 30:
            raise ValueError("archive nesting")
        if isinstance(item, plistlib.UID):
            return resolve(objects[item.data], depth + 1)
        if isinstance(item, list):
            return [resolve(v, depth + 1) for v in item]
        if isinstance(item, dict):
            if "NS.keys" in item:
                return dict(zip(resolve(item["NS.keys"], depth + 1), resolve(item["NS.objects"], depth + 1)))
            if "NS.objects" in item:
                return resolve(item["NS.objects"], depth + 1)
            if "NS.string" in item:
                return resolve(item["NS.string"], depth + 1)
            return {k: resolve(v, depth + 1) for k, v in item.items() if k != "$class"}
        return item

    return resolve(value.get("$top", {}).get("root", value))


def parse_groups(rows):
    result = {}
    for name, raw in rows:
        tokens = [x.strip() for x in raw.split(",")]
        params = dict(x.split("=", 1) for x in tokens[1:] if "=" in x)
        result[name.upper()] = {"name": name, "type": tokens[0],
                                "items": [x for x in tokens[1:] if "=" not in x],
                                "selected": params.get("policy-select-name", "")}
    return result


def resolve_chain(groups, start, default_name):
    chain, inferred = [], False
    current = start
    for _ in range(24):
        if current.upper() in [x.upper() for x in chain]:
            return chain, "", "策略组循环"
        group = groups.get(current.upper())
        if group is None:
            if current.upper() == "PROXY":
                chain.extend(["PROXY", default_name])
                return chain, default_name, "配置推断；PROXY 使用默认节点"
            chain.append(current)
            return chain, current, "配置推断；包含默认首选项" if inferred else "配置推断；手动选择记录"
        chain.append(group["name"])
        # Automatic groups cannot be resolved from static selection preferences.
        if group["type"] != "select":
            return chain, "", "自动 / 故障转移组，实际节点须查逐连接记录"
        current = group.get("selected") or next(iter(group.get("items", [])), "")
        inferred = inferred or not bool(group.get("selected"))
        if not current:
            return chain, "", "策略组未保存明确节点"
    return chain, "", "策略组嵌套过深"


def selected_node(name, default_uuid):
    # Resolve only identity fields, rather than deserializing password / key fields.
    value = plistlib.loads((GROUP / "ServerManager").read_bytes())
    objects = value["$objects"]

    def field(x):
        if isinstance(x, plistlib.UID):
            return field(objects[x.data])
        if isinstance(x, dict) and "NS.string" in x:
            return field(x["NS.string"])
        return x if isinstance(x, (str, int)) else ""

    matches = [x for x in objects if isinstance(x, dict) and "uuid" in x
               and field(x.get("title", "")).upper() == name.upper()]
    exact = [x for x in matches if field(x["uuid"]) == default_uuid]
    if exact:
        matches = exact
    if len(matches) != 1:
        hosts = {field(x.get("host", "")) for x in matches}
        return {"node_name": name, "node_id": "", "node_host": next(iter(hosts)) if len(hosts) == 1 else "",
                "subscription": "同名节点 " + str(len(matches)) + " 条；节点 ID 未唯一确认"}
    node = matches[0]
    return {"node_name": field(node.get("title", "")), "node_id": field(node["uuid"]),
            "node_host": field(node.get("host", "")),
            "subscription": "本地节点" if not field(node.get("file", "")) else "订阅节点（来源名称未确认）"}


def snapshot(service):
    domain = {"claude": "claude.ai", "gemini": "gemini.google.com"}[service]
    prefs = plistlib.loads((GROUP / "Library/Preferences/group.com.liguangming.Shadowrocket.plist").read_bytes())
    key = lambda suffix: prefs.get("group.com.liguangming." + suffix, "")
    config = key("CurrentRuleFileName")
    if not config or Path(config).name != config:
        raise ValueError("active config path")
    conn = sqlite3.connect((DATABASES / config).as_uri() + "?mode=ro", uri=True, timeout=0.25)
    groups = parse_groups(conn.execute("select name,value from config where section='proxygroup' order by docid"))
    mode = key("GlobalRoutingMethod")
    policy, matched = "", ""
    if mode == "Proxy":
        policy, matched = "PROXY", "全局代理模式"
    elif mode == "Direct":
        policy, matched = "DIRECT", "全局直连模式"
    elif mode == "Config":
        # Report a domain-rule candidate, not a runtime rule-engine verdict.
        for kind, value, option in conn.execute("select name,value,option from config where section='rule' order by docid"):
            kind, value = kind.upper(), value.lower()
            if (kind == "DOMAIN" and domain == value) or (kind == "DOMAIN-SUFFIX" and (domain == value or domain.endswith("." + value))) or (kind == "DOMAIN-KEYWORD" and value in domain):
                policy, matched = option, kind + "," + value
                break
    conn.close()
    chain, node, basis = resolve_chain(groups, policy, key("SelectedServerName")) if policy else ([], "", "没有匹配的明确域名规则")
    result = {"service": service, "domain": domain, "config": Path(config).stem + ".conf", "mode": mode,
              "matched_rule": matched, "chain": chain, "compiled_chain": [], "node_name": "", "node_id": "", "node_host": "", "subscription": "",
              "basis": basis + "；未取得逐连接日志", "error": "", "consistent": True}
    if node and node.upper() not in ("DIRECT", "REJECT", "REJECT-DROP"):
        result.update(selected_node(node, key("SelectedServerUUID") if "PROXY" in chain else ""))
    # Compare cached rule data with editable config, without accepting divergent leaves.
    try:
        conn = sqlite3.connect((GROUP / "rule.db").as_uri() + "?mode=ro", uri=True, timeout=0.25)
        row = conn.execute("select value from rule where name=? and key='policy-groups'", (config,)).fetchone()
        conn.close()
        if row and mode == "Config":
            cached = archive(row[0])
            cached = {k.upper(): {"name": v["name"], "type": v["type"], "items": v.get("items", []), "selected": v.get("parameters", {}).get("policy-select-name", "")} for k, v in cached.items()}
            cached_chain, cached_node, _ = resolve_chain(cached, policy, key("SelectedServerName"))
            result["compiled_chain"] = cached_chain
            if cached_node != node:
                result.update(consistent=False, node_name="", node_id="", node_host="", subscription="", error="编辑配置与缓存选择不一致，无法确定节点")
    except (OSError, ValueError, sqlite3.Error, KeyError):
        result["basis"] += "；缓存选择无法核对"
    result["fingerprint"] = hashlib.sha256(json.dumps(result, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return result


if __name__ == "__main__":
    try:
        print(json.dumps(snapshot(sys.argv[1]), ensure_ascii=False))
    except Exception as error:
        # Only the exception type is emitted: paths / SQL / raw config may include secrets.
        print(json.dumps({"service": sys.argv[1], "error": "Shadowrocket 快照读取失败（" + type(error).__name__ + "）"}, ensure_ascii=False))
