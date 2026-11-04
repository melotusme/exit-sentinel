"""Read only Shadowrocket routing metadata. Never emit credentials or subscription URLs."""
import hashlib
import json
import plistlib
import re
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path

GROUP = Path.home() / "Library/Group Containers/group.com.liguangming.Shadowrocket"
DATABASES = Path.home() / "Library/Containers/com.liguangming.Shadowrocket/Data/Documents/Databases"


def parse_connection_lines(text, domain, date):
    """Extract only connection identity. Never retain request URLs, headers or log bodies."""
    pattern = re.compile(r"^\[(\d\d:\d\d:\d\d\.\d+)\] (?:tcp|udp) stream <([^>]+)> proxy lookup host => "
                         + re.escape(domain) + r":\d+ server => (\S+) policy => (.*?) group => (.*?)\s*$")
    lines = text.splitlines()
    for index in range(len(lines) - 1, -1, -1):
        match = pattern.match(lines[index])
        if not match:
            continue
        clock, stream, protocol, policy, group = match.groups()
        at = datetime.strptime(date + clock, "%Y%m%d%H:%M:%S.%f").astimezone()
        if at > datetime.now().astimezone() + timedelta(minutes=1):
            at -= timedelta(days=1)
        record = {"policy": policy, "group": group, "protocol": protocol,
                  "observed_at": at.isoformat(), "server": "", "port": 0}
        endpoint = re.compile(r"stream <" + re.escape(stream) + r"> lookup host => (\[[^\]]+\]|[^\s:]+):(\d+) domain => " + re.escape(domain) + r"(?:\s|$)")
        for line in lines[index + 1:index + 24]:
            found = endpoint.search(line)
            if found:
                record.update(server=found[1].strip("[]"), port=int(found[2]))
                break
        return record
    return None


def recent_connection(domain):
    folder = GROUP / "Library/Caches/DebugLogs"
    if not folder.exists():
        return None
    # Reverse bounded reads avoid loading large debug logs on every monitoring tick.
    for path in sorted(folder.glob("PacketTunnel-*.log"), key=lambda p: p.stat().st_mtime, reverse=True)[:2]:
        date = re.search(r"PacketTunnel-(\d{8})", path.name)
        if not date or datetime.now().timestamp() - path.stat().st_mtime > 3600:
            continue
        with path.open("rb") as source:
            offset = source.seek(0, 2)
            tail = b""
            remaining = 8 * 1024 * 1024
            while offset and remaining:
                length = min(offset, 256 * 1024, remaining)
                offset -= length
                source.seek(offset)
                tail = source.read(length) + tail[:16384]
                result = parse_connection_lines(tail.decode("utf-8", "replace"), domain, date[1])
                if result:
                    return result
                remaining -= length
    return None


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


def selected_node(name, default_uuid, host="", port=0):
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
    if host:
        matches = [x for x in matches if field(x.get('host', '')) == host and
                   (not port or str(field(x.get('port', ''))) == str(port))]
    if len(matches) != 1:
        hosts = {field(x.get("host", "")) for x in matches}
        return {"node_name": name, "node_id": "", "node_host": next(iter(hosts)) if len(hosts) == 1 else "",
                "subscription": "同名节点 " + str(len(matches)) + " 条；节点 ID 未唯一确认"}
    node = matches[0]
    source = next((x for x in objects if isinstance(x, dict) and
                   str(field(x.get('type', ''))).lower() == 'subscribe' and
                   field(x.get('host', '')) == field(node.get('data', ''))), None)
    label = re.sub(r'https?://\S+', '', str(field(source.get('title', '')))).strip(' |｜·') if source else '本地节点 / 来源未确认'
    return {"node_name": field(node.get("title", "")), "node_id": field(node["uuid"]),
            "node_host": field(node.get("host", "")), "node_port": field(node.get("port", "")),
            "subscription": label,
            "subscription_id": hashlib.sha256(str(field(source.get('uuid', ''))).encode()).hexdigest() if source else ''}


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
    observed = recent_connection(domain)
    if mode == "Proxy":
        policy, matched = "PROXY", "全局代理模式"
    elif mode == "Direct":
        policy, matched = "DIRECT", "全局直连模式"
    elif mode in ("Config", "Scene"):
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
        if row and mode in ("Config", "Scene"):
            cached = archive(row[0])
            cached = {k.upper(): {"name": v["name"], "type": v["type"], "items": v.get("items", []), "selected": v.get("parameters", {}).get("policy-select-name", "")} for k, v in cached.items()}
            cached_chain, cached_node, _ = resolve_chain(cached, policy, key("SelectedServerName"))
            result["compiled_chain"] = cached_chain
            if cached_node != node:
                result.update(consistent=False, node_name="", node_id="", node_host="", subscription="", error="编辑配置与缓存选择不一致，无法确定节点")
    except (OSError, ValueError, sqlite3.Error, KeyError):
        result["basis"] += "；缓存选择无法核对"
    if observed:
        policy = observed['policy']
        if policy.upper() == 'PROXY':
            candidate = selected_node(key('SelectedServerName'), key('SelectedServerUUID'))
            # PROXY is a mutable alias: only bind it to the selected identity when the
            # same stream's actual server endpoint matches. Never attach old logs to a new node.
            if not observed['server'] or candidate.get('node_host') != observed['server'] or str(candidate.get('node_port')) != str(observed['port']):
                candidate = {"node_name": "", "node_id": "", "node_host": "", "subscription": ""}
        else:
            candidate = selected_node(policy, '', observed['server'], observed['port'])
        result.update(candidate)
        result.update(chain=[x for x in [observed['group'], policy,
                            candidate.get('node_name') if policy.upper() == 'PROXY' else ''] if x],
                      compiled_chain=[], matched_rule="逐连接记录；策略组 " + observed['group'],
                      basis="Shadowrocket 实际连接日志；仅证明此域名在记录时间使用的节点，不回显公网出口 IP",
                      evidence="connection-log", observed_at=observed['observed_at'],
                      consistent=True, error="")
        age = (datetime.now().astimezone() - datetime.fromisoformat(observed['observed_at'])).total_seconds()
        if not candidate.get('node_id'):
            result.update(consistent=False, error="连接日志中的节点身份未唯一确认，请刷新该服务连接后重试")
        elif age > 300:
            # Still the last node this domain used; the UI labels it with its age.
            result.update(stale=True)
    elif mode == 'Scene':
        result.update(consistent=False, error="场景模式暂无近期同域名连接记录；配置候选不能确认实际节点")
    identity = {k: result.get(k) for k in ['service', 'config', 'mode', 'chain', 'node_id', 'node_host', 'node_name']}
    result["fingerprint"] = hashlib.sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return result


def safe_snapshot(service):
    try:
        return snapshot(service)
    except FileNotFoundError:
        return {"service": service, "error": "未找到 Shadowrocket 配置；可能尚未安装或完成首次配置。节点快照不可用，出口检测仍可使用。"}
    except PermissionError:
        return {"service": service, "error": "无法读取 Shadowrocket 配置，请检查系统文件访问权限。出口检测仍可使用。"}
    except Exception as error:
        # Only the exception type is emitted: paths / SQL / raw config may include secrets.
        return {"service": service, "error": "Shadowrocket 快照读取失败（" + type(error).__name__ + "）；请检查客户端配置。出口检测仍可使用。"}


if __name__ == "__main__":
    # One JSON object per line, one line per requested service: a single process serves both.
    for name in sys.argv[1:]:
        print(json.dumps(safe_snapshot(name), ensure_ascii=False))
