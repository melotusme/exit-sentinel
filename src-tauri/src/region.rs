//! Place names in node labels ("日本-TY-1", "🇺🇸亚特兰大01", "US-N-5") and how close two places are.
//! Node labels are what airports use to describe the exit region; the server host is often a
//! shared relay entry, so it says little about where traffic leaves.
use serde::Serialize;

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Place {
    pub label: String,
    pub country_code: String,
    pub country: String,
    pub region: String,
    pub city: String,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub source: String,
}

struct Country {
    code: &'static str,
    zh: &'static [&'static str],
    en: &'static [&'static str],
}

struct City {
    zh: &'static [&'static str],
    en: &'static [&'static str],
    /// Airport / airline style codes; only trusted when the country agrees.
    codes: &'static [&'static str],
    country: &'static str,
    region: &'static str,
    lat: f64,
    lon: f64,
}

const COUNTRIES: &[Country] = &[
    Country { code: "US", zh: &["美国", "美國"], en: &["united states", "usa", "america"] },
    Country { code: "JP", zh: &["日本"], en: &["japan"] },
    Country { code: "KR", zh: &["韩国", "韓國", "南韩"], en: &["korea", "south korea"] },
    Country { code: "SG", zh: &["新加坡", "狮城"], en: &["singapore"] },
    Country { code: "HK", zh: &["香港"], en: &["hong kong", "hongkong"] },
    Country { code: "TW", zh: &["台湾", "台灣", "臺灣"], en: &["taiwan"] },
    Country { code: "MO", zh: &["澳门", "澳門"], en: &["macau", "macao"] },
    Country { code: "CN", zh: &["中国", "国内", "大陆", "回国"], en: &["china"] },
    Country { code: "GB", zh: &["英国", "英國"], en: &["united kingdom", "britain", "england"] },
    Country { code: "DE", zh: &["德国", "德國"], en: &["germany"] },
    Country { code: "FR", zh: &["法国", "法國"], en: &["france"] },
    Country { code: "NL", zh: &["荷兰", "荷蘭"], en: &["netherlands", "holland"] },
    Country { code: "EE", zh: &["爱沙尼亚"], en: &["estonia"] },
    Country { code: "AU", zh: &["澳大利亚", "澳洲"], en: &["australia"] },
    Country { code: "NZ", zh: &["新西兰"], en: &["new zealand"] },
    Country { code: "CA", zh: &["加拿大"], en: &["canada"] },
    Country { code: "RU", zh: &["俄罗斯", "俄羅斯"], en: &["russia"] },
    Country { code: "IN", zh: &["印度"], en: &["india"] },
    Country { code: "TR", zh: &["土耳其"], en: &["turkey", "türkiye"] },
    Country { code: "BR", zh: &["巴西"], en: &["brazil"] },
    Country { code: "AR", zh: &["阿根廷"], en: &["argentina"] },
    Country { code: "MX", zh: &["墨西哥"], en: &["mexico"] },
    Country { code: "CL", zh: &["智利"], en: &["chile"] },
    Country { code: "VN", zh: &["越南"], en: &["vietnam"] },
    Country { code: "TH", zh: &["泰国"], en: &["thailand"] },
    Country { code: "MY", zh: &["马来西亚", "大马"], en: &["malaysia"] },
    Country { code: "PH", zh: &["菲律宾"], en: &["philippines"] },
    Country { code: "ID", zh: &["印度尼西亚", "印尼"], en: &["indonesia"] },
    Country { code: "KH", zh: &["柬埔寨"], en: &["cambodia"] },
    Country { code: "IT", zh: &["意大利"], en: &["italy"] },
    Country { code: "ES", zh: &["西班牙"], en: &["spain"] },
    Country { code: "PT", zh: &["葡萄牙"], en: &["portugal"] },
    Country { code: "CH", zh: &["瑞士"], en: &["switzerland"] },
    Country { code: "AT", zh: &["奥地利"], en: &["austria"] },
    Country { code: "BE", zh: &["比利时"], en: &["belgium"] },
    Country { code: "SE", zh: &["瑞典"], en: &["sweden"] },
    Country { code: "NO", zh: &["挪威"], en: &["norway"] },
    Country { code: "FI", zh: &["芬兰"], en: &["finland"] },
    Country { code: "DK", zh: &["丹麦"], en: &["denmark"] },
    Country { code: "IE", zh: &["爱尔兰"], en: &["ireland"] },
    Country { code: "PL", zh: &["波兰"], en: &["poland"] },
    Country { code: "CZ", zh: &["捷克"], en: &["czech"] },
    Country { code: "HU", zh: &["匈牙利"], en: &["hungary"] },
    Country { code: "RO", zh: &["罗马尼亚"], en: &["romania"] },
    Country { code: "UA", zh: &["乌克兰"], en: &["ukraine"] },
    Country { code: "IS", zh: &["冰岛"], en: &["iceland"] },
    Country { code: "LU", zh: &["卢森堡"], en: &["luxembourg"] },
    Country { code: "IL", zh: &["以色列"], en: &["israel"] },
    Country { code: "AE", zh: &["阿联酋", "迪拜"], en: &["united arab emirates", "uae", "dubai"] },
    Country { code: "SA", zh: &["沙特"], en: &["saudi"] },
    Country { code: "EG", zh: &["埃及"], en: &["egypt"] },
    Country { code: "ZA", zh: &["南非"], en: &["south africa"] },
    Country { code: "NG", zh: &["尼日利亚"], en: &["nigeria"] },
    Country { code: "PK", zh: &["巴基斯坦"], en: &["pakistan"] },
    Country { code: "BD", zh: &["孟加拉"], en: &["bangladesh"] },
    Country { code: "KZ", zh: &["哈萨克斯坦"], en: &["kazakhstan"] },
    Country { code: "MN", zh: &["蒙古"], en: &["mongolia"] },
];

/// Two-letter tokens accepted as a country when nothing more specific is in the label.
const CODE_TOKENS: &[(&str, &str)] = &[
    ("US", "US"), ("USA", "US"), ("JP", "JP"), ("KR", "KR"), ("SG", "SG"), ("HK", "HK"), ("TW", "TW"),
    ("MO", "MO"), ("UK", "GB"), ("GB", "GB"), ("DE", "DE"), ("FR", "FR"), ("NL", "NL"), ("EE", "EE"),
    ("AU", "AU"), ("NZ", "NZ"), ("CA", "CA"), ("RU", "RU"), ("IN", "IN"), ("TR", "TR"), ("BR", "BR"),
    ("AR", "AR"), ("MX", "MX"), ("VN", "VN"), ("TH", "TH"), ("MY", "MY"), ("PH", "PH"), ("ID", "ID"),
    ("IT", "IT"), ("ES", "ES"), ("CH", "CH"), ("SE", "SE"), ("FI", "FI"), ("IE", "IE"), ("PL", "PL"),
    ("UA", "UA"), ("IL", "IL"), ("AE", "AE"), ("ZA", "ZA"), ("CN", "CN"),
];

const CITIES: &[City] = &[
    City { zh: &["洛杉矶", "洛杉磯"], en: &["los angeles"], codes: &["LA", "LAX"], country: "US", region: "california", lat: 34.05, lon: -118.24 },
    City { zh: &["圣何塞", "硅谷"], en: &["san jose", "silicon valley"], codes: &["SJC"], country: "US", region: "california", lat: 37.34, lon: -121.89 },
    City { zh: &["旧金山", "三藩市"], en: &["san francisco"], codes: &["SFO", "SF"], country: "US", region: "california", lat: 37.77, lon: -122.42 },
    City { zh: &["西雅图"], en: &["seattle"], codes: &["SEA"], country: "US", region: "washington", lat: 47.61, lon: -122.33 },
    City { zh: &["波特兰"], en: &["portland"], codes: &["PDX"], country: "US", region: "oregon", lat: 45.52, lon: -122.68 },
    City { zh: &["拉斯维加斯"], en: &["las vegas"], codes: &["LAS"], country: "US", region: "nevada", lat: 36.17, lon: -115.14 },
    City { zh: &["凤凰城"], en: &["phoenix"], codes: &["PHX"], country: "US", region: "arizona", lat: 33.45, lon: -112.07 },
    City { zh: &["丹佛"], en: &["denver"], codes: &["DEN"], country: "US", region: "colorado", lat: 39.74, lon: -104.99 },
    City { zh: &["盐湖城"], en: &["salt lake city"], codes: &["SLC"], country: "US", region: "utah", lat: 40.76, lon: -111.89 },
    City { zh: &["达拉斯"], en: &["dallas"], codes: &["DAL", "DFW"], country: "US", region: "texas", lat: 32.78, lon: -96.80 },
    City { zh: &["休斯顿"], en: &["houston"], codes: &["IAH"], country: "US", region: "texas", lat: 29.76, lon: -95.37 },
    City { zh: &["芝加哥"], en: &["chicago"], codes: &["CHI", "ORD"], country: "US", region: "illinois", lat: 41.88, lon: -87.63 },
    City { zh: &["堪萨斯"], en: &["kansas city"], codes: &["MCI"], country: "US", region: "missouri", lat: 39.10, lon: -94.58 },
    City { zh: &["亚特兰大"], en: &["atlanta"], codes: &["ATL"], country: "US", region: "georgia", lat: 33.75, lon: -84.39 },
    City { zh: &["迈阿密"], en: &["miami"], codes: &["MIA"], country: "US", region: "florida", lat: 25.76, lon: -80.19 },
    City { zh: &["纽约"], en: &["new york"], codes: &["NYC", "NY", "JFK"], country: "US", region: "new york", lat: 40.71, lon: -74.01 },
    City { zh: &["波士顿"], en: &["boston"], codes: &["BOS"], country: "US", region: "massachusetts", lat: 42.36, lon: -71.06 },
    City { zh: &["阿什本", "弗吉尼亚"], en: &["ashburn", "virginia"], codes: &["IAD"], country: "US", region: "virginia", lat: 39.04, lon: -77.49 },
    City { zh: &["华盛顿特区"], en: &["washington dc", "washington, d.c."], codes: &["DC"], country: "US", region: "district of columbia", lat: 38.91, lon: -77.04 },
    City { zh: &["特拉华"], en: &["delaware", "wilmington"], codes: &[], country: "US", region: "delaware", lat: 39.74, lon: -75.55 },
    City { zh: &["东京"], en: &["tokyo"], codes: &["TY", "TYO", "TK", "NRT", "HND"], country: "JP", region: "tokyo", lat: 35.68, lon: 139.69 },
    City { zh: &["大阪"], en: &["osaka"], codes: &["OS", "OSA", "KIX"], country: "JP", region: "osaka", lat: 34.69, lon: 135.50 },
    City { zh: &["首尔"], en: &["seoul"], codes: &["SEL", "ICN"], country: "KR", region: "seoul", lat: 37.57, lon: 126.98 },
    City { zh: &["春川"], en: &["chuncheon"], codes: &[], country: "KR", region: "gangwon", lat: 37.88, lon: 127.73 },
    City { zh: &["台北"], en: &["taipei"], codes: &["TPE"], country: "TW", region: "taipei", lat: 25.03, lon: 121.57 },
    City { zh: &["台中"], en: &["taichung"], codes: &[], country: "TW", region: "taichung", lat: 24.15, lon: 120.67 },
    City { zh: &["彰化"], en: &["changhua"], codes: &[], country: "TW", region: "changhua", lat: 24.08, lon: 120.54 },
    City { zh: &["高雄"], en: &["kaohsiung"], codes: &["KHH"], country: "TW", region: "kaohsiung", lat: 22.63, lon: 120.30 },
    City { zh: &["伦敦"], en: &["london"], codes: &["LON", "LHR"], country: "GB", region: "england", lat: 51.51, lon: -0.13 },
    City { zh: &["曼彻斯特"], en: &["manchester"], codes: &["MAN"], country: "GB", region: "england", lat: 53.48, lon: -2.24 },
    City { zh: &["法兰克福"], en: &["frankfurt"], codes: &["FRA"], country: "DE", region: "hesse", lat: 50.11, lon: 8.68 },
    City { zh: &["柏林"], en: &["berlin"], codes: &["BER"], country: "DE", region: "berlin", lat: 52.52, lon: 13.40 },
    City { zh: &["杜塞尔多夫"], en: &["dusseldorf", "düsseldorf"], codes: &["DUS"], country: "DE", region: "north rhine-westphalia", lat: 51.23, lon: 6.77 },
    City { zh: &["巴黎"], en: &["paris"], codes: &["PAR", "CDG"], country: "FR", region: "ile-de-france", lat: 48.86, lon: 2.35 },
    City { zh: &["马赛"], en: &["marseille"], codes: &["MRS"], country: "FR", region: "provence-alpes-cote d'azur", lat: 43.30, lon: 5.37 },
    City { zh: &["阿姆斯特丹"], en: &["amsterdam"], codes: &["AMS"], country: "NL", region: "north holland", lat: 52.37, lon: 4.90 },
    City { zh: &["塔林"], en: &["tallinn"], codes: &["TLL"], country: "EE", region: "harju", lat: 59.44, lon: 24.75 },
    City { zh: &["多伦多"], en: &["toronto"], codes: &["YYZ"], country: "CA", region: "ontario", lat: 43.65, lon: -79.38 },
    City { zh: &["温哥华"], en: &["vancouver"], codes: &["YVR"], country: "CA", region: "british columbia", lat: 49.28, lon: -123.12 },
    City { zh: &["蒙特利尔"], en: &["montreal"], codes: &["YUL"], country: "CA", region: "quebec", lat: 45.50, lon: -73.57 },
    City { zh: &["悉尼"], en: &["sydney"], codes: &["SYD"], country: "AU", region: "new south wales", lat: -33.87, lon: 151.21 },
    City { zh: &["墨尔本"], en: &["melbourne"], codes: &["MEL"], country: "AU", region: "victoria", lat: -37.81, lon: 144.96 },
    City { zh: &["莫斯科"], en: &["moscow"], codes: &["MOW"], country: "RU", region: "moscow", lat: 55.76, lon: 37.62 },
    City { zh: &["孟买"], en: &["mumbai"], codes: &["BOM"], country: "IN", region: "maharashtra", lat: 19.08, lon: 72.88 },
    City { zh: &["伊斯坦布尔"], en: &["istanbul"], codes: &["IST"], country: "TR", region: "istanbul", lat: 41.01, lon: 28.98 },
    City { zh: &["迪拜"], en: &["dubai"], codes: &["DXB"], country: "AE", region: "dubai", lat: 25.20, lon: 55.27 },
    City { zh: &["新加坡"], en: &["singapore"], codes: &["SIN"], country: "SG", region: "singapore", lat: 1.35, lon: 103.82 },
    City { zh: &["香港"], en: &["hong kong"], codes: &["HKG"], country: "HK", region: "hong kong", lat: 22.32, lon: 114.17 },
    City { zh: &["澳门"], en: &["macau"], codes: &["MFM"], country: "MO", region: "macau", lat: 22.20, lon: 113.54 },
];

/// US state names written in Chinese, mapped to the English region names used above.
const US_STATES_ZH: &[(&str, &str)] = &[
    ("加州", "california"), ("加利福尼亚", "california"), ("德州", "texas"), ("德克萨斯", "texas"),
    ("俄勒冈", "oregon"), ("华盛顿州", "washington"), ("纽约州", "new york"), ("佛罗里达", "florida"),
    ("内华达", "nevada"), ("亚利桑那", "arizona"), ("伊利诺伊", "illinois"), ("佐治亚", "georgia"),
    ("新泽西", "new jersey"), ("特拉华", "delaware"), ("弗吉尼亚", "virginia"), ("蒙大拿", "montana"),
    ("新罕布什尔", "new hampshire"), ("阿拉斯加", "alaska"),
];

fn country_name(code: &str) -> String {
    COUNTRIES.iter().find(|c| c.code == code).map(|c| c.zh[0].to_string()).unwrap_or_else(|| code.to_string())
}

/// Two regional-indicator symbols spell an ISO country code (🇺🇸 → "US").
fn flag_country(text: &str) -> Option<String> {
    let letters: Vec<char> = text
        .chars()
        .filter_map(|c| {
            let n = c as u32;
            (0x1F1E6..=0x1F1FF).contains(&n).then(|| char::from_u32('A' as u32 + n - 0x1F1E6)).flatten()
        })
        .take(2)
        .collect();
    (letters.len() == 2).then(|| {
        let code: String = letters.into_iter().collect();
        if code == "UK" { "GB".into() } else { code }
    })
}

fn tokens(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.trim_end_matches(|c: char| c.is_ascii_digit()).to_ascii_uppercase())
        .filter(|t| !t.is_empty())
        .collect()
}

fn contains_word(haystack: &str, needle: &str) -> bool {
    haystack.match_indices(needle).any(|(i, _)| {
        let before = haystack[..i].chars().last();
        let after = haystack[i + needle.len()..].chars().next();
        !before.is_some_and(|c| c.is_ascii_alphanumeric()) && !after.is_some_and(|c| c.is_ascii_alphabetic())
    })
}

fn city_place(c: &City, source: &str) -> Place {
    Place {
        label: format!("{} · {}", country_name(c.country), c.zh[0]),
        country_code: c.country.into(),
        country: country_name(c.country),
        region: c.region.into(),
        city: c.zh[0].into(),
        lat: Some(c.lat),
        lon: Some(c.lon),
        source: source.into(),
    }
}

/// Read a place from a node label. Short codes ("US", "TY") count.
pub fn parse(text: &str, source: &str) -> Option<Place> {
    parse_with(text, source, true)
}

/// Read a place from what the user typed. Short codes are ignored: "CA" in an address is
/// California far more often than Canada.
pub fn parse_query(text: &str, source: &str) -> Option<Place> {
    parse_with(text, source, false)
}

pub fn country_label(code: &str) -> String {
    country_name(code)
}

fn parse_with(text: &str, source: &str, allow_codes: bool) -> Option<Place> {
    let lower = text.to_lowercase();
    let toks = tokens(text);
    let by_name = COUNTRIES
        .iter()
        .find(|c| c.zh.iter().any(|z| text.contains(z)) || c.en.iter().any(|e| contains_word(&lower, e)))
        .map(|c| c.code.to_string());
    let us_state = US_STATES_ZH.iter().any(|(zh, _)| text.contains(zh)).then(|| "US".to_string());
    let country = by_name.or_else(|| flag_country(text)).or(us_state).or_else(|| {
        if !allow_codes {
            return None;
        }
        toks.iter().find_map(|t| CODE_TOKENS.iter().find(|(k, _)| k == t).map(|(_, v)| v.to_string()))
    });
    let named_city = CITIES.iter().find(|c| {
        (c.zh.iter().any(|z| text.contains(z)) || c.en.iter().any(|e| contains_word(&lower, e)))
            && country.as_deref().map_or(true, |cc| cc == c.country)
    });
    let coded_city = || {
        if !allow_codes {
            return None;
        }
        let cc = country.as_deref()?;
        CITIES.iter().find(|c| c.country == cc && c.codes.iter().any(|code| toks.iter().any(|t| t == code)))
    };
    if let Some(city) = named_city.or_else(coded_city) {
        return Some(city_place(city, source));
    }
    let country = country?;
    let region = if country == "US" {
        US_STATES_ZH.iter().find(|(zh, _)| text.contains(zh)).map(|(_, en)| en.to_string()).unwrap_or_default()
    } else {
        String::new()
    };
    Some(Place {
        label: if region.is_empty() { country_name(&country) } else { format!("{} · {region}", country_name(&country)) },
        country: country_name(&country),
        country_code: country,
        region,
        source: source.into(),
        ..Default::default()
    })
}

/// Great-circle distance in kilometres.
pub fn distance_km(a: (f64, f64), b: (f64, f64)) -> f64 {
    let (la1, lo1, la2, lo2) = (a.0.to_radians(), a.1.to_radians(), b.0.to_radians(), b.1.to_radians());
    let h = ((la2 - la1) / 2.0).sin().powi(2) + la1.cos() * la2.cos() * ((lo2 - lo1) / 2.0).sin().powi(2);
    6371.0 * 2.0 * h.sqrt().asin()
}

fn norm(s: &str) -> String {
    s.trim().to_lowercase().replace(['é', 'è'], "e").replace('î', "i").replace('ô', "o")
}

/// Score 0–100 for how close a node's place is to the target, with a short reason.
pub fn closeness(target: &Place, node: &Place) -> (u8, Option<f64>, String) {
    let coords = match (target.lat, target.lon, node.lat, node.lon) {
        (Some(a), Some(b), Some(c), Some(d)) => Some(distance_km((a, b), (c, d))),
        _ => None,
    };
    let same_country = !target.country_code.is_empty() && target.country_code == node.country_code;
    let same_region = same_country && !target.region.is_empty() && norm(&target.region) == norm(&node.region);
    let same_city = same_country && !target.city.is_empty() && !node.city.is_empty() && norm(&target.city) == norm(&node.city);
    let (score, reason) = match coords {
        _ if same_city => (100, "同城".to_string()),
        Some(d) if d < 150.0 => (95, format!("约 {} km", d.round())),
        _ if same_region => (85, "同州 / 省".to_string()),
        Some(d) if same_country && d < 800.0 => (75, format!("同国家，约 {} km", d.round())),
        Some(d) if same_country => (60, format!("同国家，约 {} km", d.round())),
        _ if same_country => (60, "同国家（城市未知）".to_string()),
        Some(d) if d < 1000.0 => (45, format!("邻近国家 / 地区，约 {} km", d.round())),
        _ => (0, String::new()),
    };
    (score, coords, reason)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_common_node_labels() {
        let cases = [
            ("日本-TY-1-:1.2", "JP", "东京"),
            ("日本-OS-1-:0.6", "JP", "大阪"),
            ("🇺🇸亚特兰大01|流媒体解锁|AI", "US", "亚特兰大"),
            ("🇰🇷韩国03|家宽", "KR", ""),
            ("US-N-5", "US", ""),
            ("TW-N-住宅-2", "TW", ""),
            ("荷兰-NL-2-HY2-:0.5", "NL", ""),
            ("Los Angeles 02", "US", "洛杉矶"),
            ("新加坡-SG-1-:1.0", "SG", "新加坡"),
        ];
        for (label, cc, city) in cases {
            let p = parse(label, "名称").unwrap_or_else(|| panic!("{label}"));
            assert_eq!(p.country_code, cc, "{label}");
            assert_eq!(p.city, city, "{label}");
        }
    }

    #[test]
    fn ignores_labels_without_place() {
        assert!(parse("❗请到网站使用教程|0.1x", "名称").is_none());
        assert!(parse("vl-reality-Debian13", "名称").is_none());
        assert!(parse("剩余流量：100GB", "名称").is_none());
    }

    #[test]
    fn city_code_needs_matching_country() {
        // "OS" alone is not Osaka; "AT" after 日本 is not Austria.
        assert!(parse("OS-1", "名称").is_none());
        assert_eq!(parse("日本-TY-4-AT-:0.6", "名称").unwrap().city, "东京");
    }

    #[test]
    fn query_ignores_short_codes() {
        assert!(parse_query("1600 Amphitheatre Pkwy, CA", "输入").is_none());
        assert_eq!(parse("CA-01", "名称").unwrap().country_code, "CA");
    }

    #[test]
    fn reads_user_queries() {
        assert_eq!(parse_query("加州", "输入").unwrap().region, "california");
        assert_eq!(parse_query("Seattle, WA", "输入").unwrap().city, "西雅图");
        assert_eq!(parse_query("东京都新宿区", "输入").unwrap().country_code, "JP");
    }

    #[test]
    fn closeness_ranks_city_region_country() {
        let la = parse("洛杉矶", "t").unwrap();
        let sj = parse("圣何塞", "t").unwrap();
        let atl = parse("亚特兰大", "t").unwrap();
        let us = parse("美国", "t").unwrap();
        let tokyo = parse("东京", "t").unwrap();
        assert_eq!(closeness(&la, &la).0, 100);
        assert_eq!(closeness(&la, &sj).0, 85);
        assert_eq!(closeness(&la, &atl).0, 60);
        assert_eq!(closeness(&la, &us).0, 60);
        assert_eq!(closeness(&la, &tokyo).0, 0);
        let hk = parse("香港", "t").unwrap();
        let macau = parse("澳门", "t").unwrap();
        assert!(closeness(&hk, &macau).0 >= 45);
    }
}
