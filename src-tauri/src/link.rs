//! Which physical link carries traffic out of this machine: wired, Wi-Fi (with its name) or
//! unknown. A TUN / VPN default route is looked through to the real interface underneath.
use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Medium {
    Wired,
    Wireless,
    #[default]
    Unknown,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Uplink {
    pub medium: Medium,
    /// System interface name, e.g. en0 / eth0 / Wi-Fi.
    pub interface: String,
    /// Hardware port or adapter description, e.g. "USB 10/100/1G/2.5G LAN".
    pub port: String,
    /// Wi-Fi network name. Empty when wired, or when the system withholds it.
    pub ssid: String,
    /// Why the Wi-Fi name is missing, if it is.
    pub ssid_hint: String,
}

impl Uplink {
    /// Short text for menus and change records: "有线 · en6", "无线 · HomeWiFi".
    pub fn label(&self) -> String {
        match self.medium {
            Medium::Wired => format!("有线 · {}", if self.port.is_empty() { &self.interface } else { &self.port }),
            Medium::Wireless if !self.ssid.is_empty() => format!("无线 · {}", self.ssid),
            Medium::Wireless => format!("无线 · {}", if self.ssid_hint.is_empty() { "名称未知" } else { &self.ssid_hint }),
            Medium::Unknown if self.interface.is_empty() => "未连接".into(),
            Medium::Unknown => format!("未知 · {}", self.interface),
        }
    }
}

/// Interfaces that only tunnel traffic. The physical uplink is found beneath them.
pub fn is_virtual(name: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "utun", "tun", "tap", "ipsec", "ppp", "feth", "bridge", "awdl", "llw", "lo", "gif", "stf", "anpi", "ap",
        "docker", "veth", "virbr", "br-", "wg", "tailscale", "zt", "vmnet", "vboxnet", "Meta", "Mihomo", "clash",
    ];
    PREFIXES.iter().any(|p| name.starts_with(p))
}

/// Physical interfaces from `scutil --nwi`, highest priority first.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn nwi_interfaces(nwi: &str) -> Vec<String> {
    nwi.lines()
        .find_map(|l| l.trim().strip_prefix("Network interfaces:"))
        .map(|rest| rest.split_whitespace().filter(|n| !is_virtual(n)).map(String::from).collect())
        .unwrap_or_default()
}

/// `networksetup -listallhardwareports` as (device, hardware port).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn hardware_ports(text: &str) -> Vec<(String, String)> {
    let mut out = vec![];
    let mut port = String::new();
    for line in text.lines() {
        if let Some(p) = line.strip_prefix("Hardware Port: ") {
            port = p.trim().to_string();
        } else if let Some(d) = line.strip_prefix("Device: ") {
            out.push((d.trim().to_string(), std::mem::take(&mut port)));
        }
    }
    out
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn is_wifi_port(port: &str) -> bool {
    let p = port.to_ascii_lowercase();
    p.contains("wi-fi") || p.contains("airport") || p.contains("wlan") || p.contains("wireless")
}

/// `ipconfig getsummary <if>`: (InterfaceType, SSID). macOS prints `<redacted>` for the SSID
/// unless the caller has location permission.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn ipconfig_summary(text: &str) -> (String, String) {
    let field = |key: &str| {
        text.lines()
            .find_map(|l| l.trim().strip_prefix(key).and_then(|r| r.trim_start().strip_prefix(':')))
            .map(|v| v.trim().to_string())
            .unwrap_or_default()
    };
    let ssid = field("SSID");
    let ssid = if ssid.starts_with('<') && ssid.ends_with('>') { String::new() } else { ssid };
    (field("InterfaceType"), ssid)
}

/// Pick the uplink from the macOS readings. Pure so it can be tested.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn macos_uplink(
    nwi: &str,
    ports: &[(String, String)],
    summary: impl Fn(&str) -> (String, String),
    wifi_name: impl Fn(&str) -> Option<String>,
) -> Uplink {
    let Some(interface) = nwi_interfaces(nwi).into_iter().next() else {
        return Uplink::default();
    };
    let port = ports.iter().find(|(d, _)| *d == interface).map(|(_, p)| p.clone()).unwrap_or_default();
    let (kind, ssid) = summary(&interface);
    let wireless = kind.eq_ignore_ascii_case("wifi") || is_wifi_port(&port);
    let medium = if wireless {
        Medium::Wireless
    } else if kind.eq_ignore_ascii_case("ethernet") || !port.is_empty() {
        Medium::Wired
    } else {
        Medium::Unknown
    };
    let mut up = Uplink { medium, interface, port, ..Default::default() };
    if wireless {
        up.ssid = if ssid.is_empty() { wifi_name(&up.interface).unwrap_or_default() } else { ssid };
        if up.ssid.is_empty() {
            up.ssid_hint = "Wi-Fi 名称暂不可用，请到设置 → 权限检查定位权限".into();
        }
    }
    up
}

#[cfg(target_os = "macos")]
pub fn current() -> Uplink {
    let run = |bin: &str, args: &[&str]| {
        crate::command(bin)
            .args(args)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default()
    };
    let nwi = run("/usr/sbin/scutil", &["--nwi"]);
    let ports = hardware_ports(&run("/usr/sbin/networksetup", &["-listallhardwareports"]));
    let mut up = macos_uplink(
        &nwi,
        &ports,
        |name| ipconfig_summary(&run("/usr/sbin/ipconfig", &["getsummary", name])),
        macos_wifi::ssid,
    );
    if up.medium == Medium::Wireless && up.ssid.is_empty() && wifi_permission_status() == "granted" {
        up.ssid_hint = "已获定位权限，Wi-Fi 名称暂未返回".into();
    }
    up
}

/// CoreWLAN returns the SSID once Location Services allows this app; otherwise nil.
#[cfg(target_os = "macos")]
mod macos_wifi {
    use objc2_core_wlan::CWWiFiClient;
    use objc2_foundation::NSString;

    pub fn ssid(interface: &str) -> Option<String> {
        unsafe {
            let client = CWWiFiClient::sharedWiFiClient();
            let name = NSString::from_str(interface);
            client.interfaceWithName(Some(&name))?.ssid().map(|s| s.to_string())
        }
        .filter(|s| !s.is_empty())
    }
}

/// Outcome of asking for the permission that unlocks the Wi-Fi name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WifiPermission {
    /// The system prompt was shown.
    Requested,
    /// Already allowed; the next check reads the name.
    Granted,
    /// The user said no earlier; only System Settings can change it now.
    Denied,
    /// Location Services is switched off for the whole Mac.
    ServicesOff,
    /// No prompt exists on this system (Windows); the settings page was opened.
    SettingsOnly,
}

impl WifiPermission {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Requested => "requested",
            Self::Granted => "granted",
            Self::Denied => "denied",
            Self::ServicesOff => "services_off",
            Self::SettingsOnly => "settings",
        }
    }

    /// Whether the user has to finish the change in system settings.
    pub fn needs_settings(self) -> bool {
        matches!(self, Self::Denied | Self::ServicesOff | Self::SettingsOnly)
    }

    /// One line for a notification or toast.
    pub fn message(self) -> &'static str {
        match self {
            Self::Requested => "已弹出定位权限申请。点“允许”后会自动显示 Wi-Fi 名称；出口哨兵不读取也不保存你的位置。",
            Self::Granted => "已有定位权限，正在重新读取 Wi-Fi 名称…",
            Self::Denied => "定位权限之前被拒绝，系统不会再弹窗。已打开 系统设置 → 隐私与安全性 → 定位服务，请打开 Exit Sentinel 的开关。",
            Self::ServicesOff => "这台 Mac 关闭了定位服务。已打开 系统设置 → 隐私与安全性 → 定位服务，请先打开总开关，再允许 Exit Sentinel。",
            Self::SettingsOnly => "已打开系统定位设置。请打开“定位服务”和“允许桌面应用访问你的位置”，用于读取 Wi-Fi 名称。",
        }
    }
}

/// System Settings → Privacy & Security → Location Services (macOS), or Windows location privacy.
pub const LOCATION_SETTINGS_URL: &str = if cfg!(target_os = "windows") {
    "ms-settings:privacy-location"
} else {
    "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices"
};

/// Whether this system has a location settings page worth linking to.
pub const HAS_LOCATION_SETTINGS: bool = cfg!(any(target_os = "macos", target_os = "windows"));

/// Open the location privacy page in system settings.
pub fn open_location_settings() -> Result<(), String> {
    if !HAS_LOCATION_SETTINGS {
        return Err("此系统没有定位权限设置".into());
    }
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = crate::command("cmd");
        c.args(["/C", "start", "", LOCATION_SETTINGS_URL]);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = crate::command("/usr/bin/open");
        c.arg(LOCATION_SETTINGS_URL);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| format!("无法打开系统设置：{e}"))
}

/// Ask for the Wi-Fi name permission, and open system settings when a prompt can no longer
/// help. Call on the main thread (macOS shows the prompt only from there).
pub fn request_or_open_settings() -> Result<WifiPermission, String> {
    let result = request_wifi_name_permission();
    if result.needs_settings() {
        open_location_settings()?;
    }
    Ok(result)
}

/// Read authorization without prompting or opening settings.
#[cfg(target_os = "macos")]
pub fn wifi_permission_status() -> &'static str {
    use objc2_core_location::{CLAuthorizationStatus, CLLocationManager};
    if !unsafe { CLLocationManager::locationServicesEnabled_class() } { return "services_off"; }
    #[allow(deprecated)]
    match unsafe { CLLocationManager::authorizationStatus_class() } {
        CLAuthorizationStatus::NotDetermined => "not_determined",
        CLAuthorizationStatus::Denied => "denied",
        CLAuthorizationStatus::Restricted => "restricted",
        _ => "granted",
    }
}
#[cfg(target_os = "windows")]
pub fn wifi_permission_status() -> &'static str { "settings" }
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn wifi_permission_status() -> &'static str { "not_required" }

/// Ask once for Location Services so CoreWLAN may return the Wi-Fi name. macOS shows the
/// prompt only while the status is "not determined"; afterwards the user changes it in
/// System Settings → Privacy & Security → Location Services.
#[cfg(target_os = "macos")]
pub fn request_wifi_name_permission() -> WifiPermission {
    use objc2_core_location::{CLAuthorizationStatus, CLLocationManager};
    use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
    use objc2::runtime::ProtocolObject;
    use objc2_foundation::{NSObject, NSObjectProtocol};
    use objc2_core_location::CLLocationManagerDelegate;
    use std::cell::RefCell;
    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "ExitSentinelLocationDelegate"]
        #[thread_kind = MainThreadOnly]
        struct LocationDelegate;
        unsafe impl NSObjectProtocol for LocationDelegate {}
        unsafe impl CLLocationManagerDelegate for LocationDelegate {
            #[unsafe(method(locationManagerDidChangeAuthorization:))]
            unsafe fn authorization_changed(&self, _manager: &CLLocationManager) {}
        }
    );
    // Core Location requires a delegate before requesting authorization. Both weak
    // delegate and manager must stay alive while the system prompt is displayed.
    thread_local! {
        static MANAGER: RefCell<Option<(objc2::rc::Retained<CLLocationManager>, objc2::rc::Retained<LocationDelegate>)>> = const { RefCell::new(None) };
    }
    let mtm = MainThreadMarker::new().expect("request Wi-Fi permission on the main thread");
    if !unsafe { CLLocationManager::locationServicesEnabled_class() } {
        return WifiPermission::ServicesOff;
    }
    let manager = MANAGER.with(|slot| {
        let mut slot = slot.borrow_mut();
        let (manager, _) = slot.get_or_insert_with(|| unsafe {
            let delegate: objc2::rc::Retained<LocationDelegate> = msg_send![mtm.alloc(), init];
            let manager = CLLocationManager::new();
            manager.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            (manager, delegate)
        });
        manager.clone()
    });
    #[allow(deprecated)]
    let status = unsafe { CLLocationManager::authorizationStatus_class() };
    match status {
        CLAuthorizationStatus::NotDetermined => {
            unsafe { manager.requestWhenInUseAuthorization() };
            WifiPermission::Requested
        }
        CLAuthorizationStatus::Denied | CLAuthorizationStatus::Restricted => WifiPermission::Denied,
        _ => WifiPermission::Granted,
    }
}

#[cfg(target_os = "windows")]
pub fn request_wifi_name_permission() -> WifiPermission {
    WifiPermission::SettingsOnly
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn request_wifi_name_permission() -> WifiPermission {
    WifiPermission::Granted
}

/// Linux: the device behind the default route, its type from sysfs, and the SSID from nmcli
/// or iwgetid when available.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn current() -> Uplink {
    let run = |bin: &str, args: &[&str]| {
        crate::command(bin)
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    };
    let routes = run("ip", &["-4", "route", "show", "default"]) + "\n" + &run("ip", &["-6", "route", "show", "default"]);
    let interface = linux_default_device(&routes, |d| std::path::Path::new(&format!("/sys/class/net/{d}/device")).exists());
    if interface.is_empty() {
        return Uplink::default();
    }
    let wireless = std::path::Path::new(&format!("/sys/class/net/{interface}/wireless")).exists()
        || std::path::Path::new(&format!("/sys/class/net/{interface}/phy80211")).exists();
    let mut up = Uplink {
        medium: if wireless { Medium::Wireless } else { Medium::Wired },
        interface: interface.clone(),
        ..Default::default()
    };
    if wireless {
        up.ssid = run("iwgetid", &[interface.as_str(), "-r"]);
        if up.ssid.is_empty() {
            up.ssid = linux_nmcli_ssid(&run("nmcli", &["-t", "-f", "ACTIVE,SSID,DEVICE", "dev", "wifi"]), &interface);
        }
        if up.ssid.is_empty() {
            up.ssid_hint = "未能读取 Wi-Fi 名称（需要 NetworkManager 或 iwgetid）".into();
        }
    }
    up
}

/// First default-route device that is a real NIC. Falls back to the first non-virtual one.
#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
pub fn linux_default_device(routes: &str, is_physical: impl Fn(&str) -> bool) -> String {
    let devices: Vec<&str> = routes
        .lines()
        .filter_map(|l| l.split_whitespace().skip_while(|w| *w != "dev").nth(1))
        .collect();
    devices
        .iter()
        .find(|d| is_physical(d))
        .or_else(|| devices.iter().find(|d| !is_virtual(d)))
        .map(|d| d.to_string())
        .unwrap_or_default()
}

/// `nmcli -t -f ACTIVE,SSID,DEVICE dev wifi`. SSIDs may contain escaped colons.
#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
pub fn linux_nmcli_ssid(text: &str, interface: &str) -> String {
    text.lines()
        .filter_map(|l| {
            let rest = l.strip_prefix("yes:")?;
            let (ssid, device) = rest.rsplit_once(':')?;
            (device == interface).then(|| ssid.replace("\\:", ":"))
        })
        .next()
        .unwrap_or_default()
}

/// Windows: the connected adapter with the lowest route metric, its type, and the SSID from
/// `netsh wlan show interfaces`.
#[cfg(target_os = "windows")]
pub fn current() -> Uplink {
    let run = |bin: &str, args: &[&str]| {
        crate::command(bin)
            .args(args)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default()
    };
    let script = "Get-NetRoute -DestinationPrefix 0.0.0.0/0 -ErrorAction SilentlyContinue | Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | ForEach-Object { Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue } | Where-Object { $_.Status -eq 'Up' -and -not $_.Virtual } | Select-Object -First 1 | ForEach-Object { \"$($_.Name)`t$($_.InterfaceDescription)`t$($_.PhysicalMediaType)`t$($_.NdisPhysicalMedium)\" }";
    let line = run("powershell.exe", &["-NoProfile", "-NonInteractive", "-Command", script]);
    let mut up = windows_adapter(line.trim());
    if up.medium == Medium::Wireless {
        up.ssid = windows_netsh_ssid(&run("netsh.exe", &["wlan", "show", "interfaces"]), &up.interface);
        if up.ssid.is_empty() {
            up.ssid_hint = "需要开启 Windows 定位权限才能读取 Wi-Fi 名称".into();
        }
    }
    up
}

/// One tab-separated row: Name, InterfaceDescription, PhysicalMediaType, NdisPhysicalMedium.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn windows_adapter(line: &str) -> Uplink {
    let mut cols = line.split('\t');
    let name = cols.next().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Uplink::default();
    }
    let desc = cols.next().unwrap_or("").trim().to_string();
    let media = cols.next().unwrap_or("").to_ascii_lowercase();
    let ndis = cols.next().unwrap_or("").trim();
    // NdisPhysicalMedium 9 = Native 802.11, 14 = 802.3.
    let wireless = media.contains("802.11") || media.contains("wireless") || ndis == "9";
    let wired = media.contains("802.3") || ndis == "14" || ndis == "0";
    Uplink {
        medium: if wireless { Medium::Wireless } else if wired { Medium::Wired } else { Medium::Unknown },
        interface: name,
        port: desc,
        ..Default::default()
    }
}

/// `netsh wlan show interfaces`: the SSID of the named adapter (or the only one).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn windows_netsh_ssid(text: &str, interface: &str) -> String {
    let mut current_name = String::new();
    let mut found = vec![];
    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let key = key.trim();
        let value = value.trim().to_string();
        if key == "Name" || key == "名称" {
            current_name = value;
        } else if key == "SSID" {
            found.push((current_name.clone(), value));
        }
    }
    found
        .iter()
        .find(|(n, _)| n == interface)
        .or_else(|| (found.len() == 1).then(|| &found[0]))
        .map(|(_, s)| s.clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NWI: &str = "Network information\n\nIPv4 network interface information\n   utun4 : flags : 0x7\n     en6 : flags : 0x5\n     en0 : flags : 0x5\n feth272 : flags : 0x1\n\nNetwork interfaces: utun4 en6 en0 feth272\n";
    const PORTS: &str = "\nHardware Port: USB 10/100/1G/2.5G LAN\nDevice: en6\nEthernet Address: 00:00:00:00:00:01\n\nHardware Port: Wi-Fi\nDevice: en0\nEthernet Address: 00:00:00:00:00:02\n";

    #[test]
    fn macos_looks_through_tun_to_the_wired_port() {
        let up = macos_uplink(NWI, &hardware_ports(PORTS), |_| ("Ethernet".into(), String::new()), |_| None);
        assert_eq!(up.medium, Medium::Wired);
        assert_eq!(up.interface, "en6");
        assert_eq!(up.label(), "有线 · USB 10/100/1G/2.5G LAN");
    }

    #[test]
    fn macos_wifi_reports_name_or_why_it_is_missing() {
        let nwi = "Network interfaces: utun4 en0\n";
        let ports = hardware_ports(PORTS);
        let redacted = ipconfig_summary("  InterfaceType : WiFi\n  SSID : <redacted>\n");
        assert_eq!(redacted, ("WiFi".into(), String::new()));
        let up = macos_uplink(nwi, &ports, |_| redacted.clone(), |_| None);
        assert_eq!(up.medium, Medium::Wireless);
        assert!(up.ssid.is_empty() && up.label().contains("定位权限"));
        let up = macos_uplink(nwi, &ports, |_| redacted.clone(), |_| Some("Office-5G".into()));
        assert_eq!(up.label(), "无线 · Office-5G");
        let up = macos_uplink(nwi, &ports, |_| ("WiFi".into(), "Home".into()), |_| None);
        assert_eq!(up.ssid, "Home");
    }

    #[test]
    fn wifi_permission_opens_settings_only_when_a_prompt_cannot_help() {
        assert!(!WifiPermission::Requested.needs_settings());
        assert!(!WifiPermission::Granted.needs_settings());
        assert!(WifiPermission::Denied.needs_settings());
        assert!(WifiPermission::ServicesOff.needs_settings());
        assert!(WifiPermission::SettingsOnly.needs_settings());
        #[cfg(target_os = "macos")]
        assert!(LOCATION_SETTINGS_URL.ends_with("Privacy_LocationServices"));
    }

    #[test]
    fn no_physical_interface_is_not_connected() {
        let up = macos_uplink("Network interfaces: utun4\n", &[], |_| Default::default(), |_| None);
        assert_eq!(up, Uplink::default());
        assert_eq!(up.label(), "未连接");
    }

    #[test]
    fn linux_prefers_physical_default_route() {
        let routes = "default via 198.18.0.1 dev Meta\ndefault via 192.168.1.1 dev wlan0 proto dhcp metric 600\n";
        assert_eq!(linux_default_device(routes, |d| d == "wlan0"), "wlan0");
        assert_eq!(linux_default_device(routes, |_| false), "wlan0");
        assert_eq!(linux_nmcli_ssid("no:Other:wlan0\nyes:My\\:Net:wlan0\n", "wlan0"), "My:Net");
    }

    #[test]
    fn windows_adapter_type_and_ssid() {
        let up = windows_adapter("Wi-Fi\tIntel(R) Wi-Fi 6E AX211\tNative 802.11\t9");
        assert_eq!(up.medium, Medium::Wireless);
        let up = windows_adapter("以太网\tRealtek PCIe GbE\t802.3\t14");
        assert_eq!(up.medium, Medium::Wired);
        let netsh = "    Name                   : Wi-Fi\n    State                  : connected\n    SSID                   : Cafe\n    BSSID                  : 00:00:00:00:00:00\n";
        assert_eq!(windows_netsh_ssid(netsh, "Wi-Fi"), "Cafe");
    }
}
