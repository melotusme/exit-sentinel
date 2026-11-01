use serde_json::{json, Value};
use std::collections::HashMap;

// Conservative offline reference list. ASN ownership is evidence of a cloud/CDN
// network, not proof of a subscriber's actual product or a site's risk verdict.
pub fn classification(g: &Value) -> Value {
    let asn = g["connection"]["asn"].as_u64().unwrap_or(0);
    let cloud = match asn {
        16509 | 14618 => Some("Amazon AWS"),
        8075 => Some("Microsoft Azure"),
        396982 => Some("Google Cloud"),
        45102 => Some("Alibaba Cloud"),
        45090 | 132203 => Some("Tencent Cloud"),
        31898 => Some("Oracle Cloud"),
        14061 => Some("DigitalOcean"),
        24940 => Some("Hetzner"),
        16276 => Some("OVH"),
        20473 => Some("Vultr"),
        63949 => Some("Linode / Akamai Cloud"),
        13335 => Some("Cloudflare CDN"),
        _ => None,
    };
    let operator = matches!(asn, 4134 | 4812 | 4809 | 4837 | 9929 | 9808 | 56048 | 58453);
    let (label, basis, idc) = if let Some(name) = cloud {
        (
            "IDC / 云服务 / CDN（ASN 参考）",
            format!("AS{asn}：{name}，已知云或 CDN 网络；不能据此判断具体租用产品"),
            "是（ASN 参考）",
        )
    } else if operator {
        (
            "运营商网络（家宽 / 移动未确认）",
            format!("AS{asn} 为综合运营商网络；同一 ASN 可承载家宽、移动和企业接入"),
            "未确认",
        )
    } else {
        (
            "其他 / 未确认",
            "当前数据源没有可靠的接入类型字段；不根据 ISP 名称猜测家宽或移动网络".into(),
            "未确认",
        )
    };
    json!({"label":label,"basis":basis,"idc":idc,
        "residential":"未确认（无家宽证据）", "mobile":"未确认（无移动接入证据）",
        "other":"未确认（企业 / 教育 / 政府 / 其他需专门数据）",
        "source":"ipwho.is ASN + 本地保守 ASN 参考表 v2026-10-28；不是商业 IP 类型数据库"})
}
// State sales tax only; local taxes and product-specific rules can differ.
pub fn sales_tax(g: &Value) -> Value {
    let country = g["country_code"].as_str().unwrap_or("");
    let region = g["region"].as_str().unwrap_or("").trim().to_lowercase();
    let code = g["region_code"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_uppercase();
    let note = "按 IP 数据库州份判断，仅指州级销售税；不代表账单地址、实际消费地或具体交易免税。";
    if country != "US" {
        return json!({"status":if country.is_empty(){"unknown"}else{"not_us"},"label":if country.is_empty(){"未确认（国家缺失）"}else{"不适用（非美国出口）"},"note":note});
    }
    let states = [
        ("AK", "alaska", "阿拉斯加"),
        ("DE", "delaware", "特拉华"),
        ("MT", "montana", "蒙大拿"),
        ("NH", "new hampshire", "新罕布什尔"),
        ("OR", "oregon", "俄勒冈"),
    ];
    // Prefer the full state name; a contradictory code must not imply exemption.
    let found = states.iter().find(|(c, n, zh)| {
        if region.is_empty() {
            code == *c
        } else {
            region == *n
                || region == c.to_lowercase()
                || region == *zh
                || region == format!("{zh}州")
        }
    });
    if let Some((code, _, name)) = found {
        return json!({"status":"no_state_sales_tax","label":format!("免税州 · {name}（无州级销售税）"),"note":if *code == "AK"{format!("阿拉斯加部分城市 / 自治市征收地方销售税。{note}")}else{note.into()}});
    }
    let known = "AL AZ AR CA CO CT FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO NE NV NJ NM NY NC ND OH OK PA RI SC SD TN TX UT VT VA WA WV WI WY DC";
    let names = [
        "alabama",
        "arizona",
        "arkansas",
        "california",
        "colorado",
        "connecticut",
        "florida",
        "georgia",
        "hawaii",
        "idaho",
        "illinois",
        "indiana",
        "iowa",
        "kansas",
        "kentucky",
        "louisiana",
        "maine",
        "maryland",
        "massachusetts",
        "michigan",
        "minnesota",
        "mississippi",
        "missouri",
        "nebraska",
        "nevada",
        "new jersey",
        "new mexico",
        "new york",
        "north carolina",
        "north dakota",
        "ohio",
        "oklahoma",
        "pennsylvania",
        "rhode island",
        "south carolina",
        "south dakota",
        "tennessee",
        "texas",
        "utah",
        "vermont",
        "virginia",
        "washington",
        "west virginia",
        "wisconsin",
        "wyoming",
        "district of columbia",
    ];
    let recognized = names.contains(&region.as_str())
        || known.split_whitespace().any(|c| {
            if region.is_empty() {
                c == code
            } else {
                c.eq_ignore_ascii_case(&region)
            }
        });
    json!({"status":if recognized{"state_sales_tax"}else{"unknown"},"label":if recognized{"非免税州（有州级销售税）"}else{"未确认（州份缺失或无法识别）"},"note":note})
}

pub fn enrich(g: &mut Value) {
    g["network_type"] = classification(g);
    g["sales_tax"] = sales_tax(g);
}

pub fn insert_cache(cache: &mut HashMap<String, (u64, Value)>, key: String, value: (u64, Value)) {
    if !cache.contains_key(&key) && cache.len() >= 128 {
        if let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, (time, _))| time)
            .map(|(key, _)| key.clone())
        {
            cache.remove(&oldest);
        }
    }
    cache.insert(key, value);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sales_tax_states_and_unknowns() {
        for name in ["Alaska", "Delaware", "Montana", "New Hampshire", "Oregon"] {
            assert_eq!(
                sales_tax(&json!({"country_code":"US","region":name}))["status"],
                "no_state_sales_tax"
            );
        }
        assert!(
            sales_tax(&json!({"country_code":"US","region":"Alaska"}))["note"]
                .as_str()
                .unwrap()
                .contains("地方销售税")
        );
        assert_eq!(
            sales_tax(&json!({"country_code":"US","region":"California","region_code":"OR"}))
                ["status"],
            "state_sales_tax"
        );
        assert_eq!(
            sales_tax(&json!({"country_code":"US","region_code":"OR"}))["status"],
            "no_state_sales_tax"
        );
        assert_eq!(
            sales_tax(&json!({"country_code":"US","region":"Atlantis"}))["status"],
            "unknown"
        );
        assert_eq!(
            sales_tax(&json!({"country_code":"US"}))["status"],
            "unknown"
        );
        assert_eq!(
            sales_tax(&json!({"country_code":"CA","region":"Oregon"}))["status"],
            "not_us"
        );
        assert_eq!(sales_tax(&json!({}))["status"], "unknown");
    }
    #[test]
    fn conservative_classification() {
        assert_eq!(
            classification(&json!({"connection":{"asn":16509}}))["idc"],
            "是（ASN 参考）"
        );
        let mobile_brand =
            classification(&json!({"connection":{"asn":56048,"isp":"China Mobile"}}));
        assert_eq!(mobile_brand["mobile"], "未确认（无移动接入证据）");
        assert_eq!(mobile_brand["residential"], "未确认（无家宽证据）");
        assert_eq!(classification(&json!({}))["label"], "其他 / 未确认");
    }
    #[test]
    fn cache_roundtrip_and_bounded_eviction() {
        let mut cache = HashMap::new();
        for i in 0..128 {
            insert_cache(&mut cache, i.to_string(), (i, json!({"postal":"43215"})));
        }
        let serialized = serde_json::to_vec(&cache).unwrap();
        let mut restored: HashMap<String, (u64, Value)> =
            serde_json::from_slice(&serialized).unwrap();
        assert_eq!(restored["0"].1["postal"], "43215");
        insert_cache(&mut restored, "new".into(), (129, json!({})));
        assert_eq!(restored.len(), 128);
        assert!(!restored.contains_key("0"));
        assert!(restored.contains_key("127"));
    }
}
