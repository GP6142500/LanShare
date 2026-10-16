//! Windows 防火墙放行助手。
//!
//! 背景：LanShare 在 `0.0.0.0:<port>` 上监听，局域网设备要**主动连进来**，属入站连接。
//! Windows Defender 防火墙默认拦截一切入站流量，除非有显式放行规则。若用户在
//! 「是否允许访问网络」弹窗上点了取消、或该弹窗被静默跳过，外部设备连过来会被
//! 静默丢包 —— 浏览器表现为「无法连接」，且没有任何错误提示，用户极难自查。
//!
//! 设计要点：**按程序放行，而不是按端口放行**。
//!   - 按端口（`localport=18765`）的规则在用户改端口后就失效了，得重新加；
//!   - 按程序（`program=<exe 绝对路径>`）的规则跟着 exe 走，改端口、换网络都不用管。
//! 代价是：程序被移动/重装到别的路径后，旧规则不再匹配 —— 这由前端的
//! 「检测 + 一键修复」覆盖（检测到无规则就再放行一次）。
//!
//! 权限：查询不需要管理员；**添加规则必须提权**。所以这里只负责「查」，
//! 「加」交给前端在用户点击时用 UAC 提权执行（`runas`），避免软件一启动就弹 UAC。

use std::path::PathBuf;

/// 放行规则名。按程序放行时，规则名只作为标识；
/// 用固定名字便于「先删旧规则再加新规则」时精准定位。
pub const RULE_NAME: &str = "LanShare LAN Access";

/// 防火墙放行状态。
#[derive(serde::Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum FirewallStatus {
    /// 已有覆盖 TCP 入站的放行规则，局域网可以连进来
    Allowed,
    /// 没有找到放行规则 —— 大概率连不上，需要一键修复
    Blocked,
    /// 非 Windows 或检测失败（比如 PowerShell 不可用），不下结论、不弹提示
    Unknown,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct FirewallInfo {
    pub status: FirewallStatus,
    /// 当前程序路径（展示给用户，也用于生成提权命令）
    pub program: String,
    /// 已匹配到的规则概要（调试/展示用）
    pub rules: Vec<String>,
    /// 是否具备管理员权限（决定按钮上要不要提示「需要管理员」）
    pub elevated: bool,
}

/// 当前可执行文件路径。提权执行 netsh 时必须以它为 `program=` 值。
pub fn current_program() -> Option<PathBuf> {
    std::env::current_exe().ok()
}

/// 是否以管理员身份运行。
pub fn is_elevated() -> bool {
    #[cfg(windows)]
    {
        // `net session` 只有管理员能成功执行；比引入 winapi 更省依赖。
        // 用 CREATE_NO_WINDOW 避免闪出黑框。
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        return std::process::Command::new("net")
            .arg("session")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// 查询当前 exe 是否已有「入站 TCP 放行」规则。
///
/// 用 PowerShell 的 `Get-NetFirewallRule` + `Get-NetFirewallApplicationFilter`：
/// 它能按程序路径精确匹配，而 `netsh advfirewall firewall show rule` 不支持 program 过滤。
///
/// 注意「Profile 是否覆盖」：Windows 网络权限弹窗只会给**当时所在**的网络类型
/// （专用/公用）加规则，换到另一类网络就失效了。所以这里必须检查覆盖情况 ——
/// 只放行了 Public 而当前网络是 Private 时，连接照样会被拦。
#[cfg(windows)]
pub fn check() -> FirewallInfo {
    let program = current_program()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let elevated = is_elevated();
    if program.is_empty() {
        return FirewallInfo {
            status: FirewallStatus::Unknown,
            program,
            rules: vec![],
            elevated,
        };
    }

    // 输出三段：匹配到的规则名、覆盖的 profile、以及当前活动网络的类型。
    let script = format!(
        r#"
$exe = {exe}
$hits = Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow -ErrorAction SilentlyContinue |
  Where-Object {{
    $p = ($_ | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue).Program
    $p -and ($p -ieq $exe)
  }}
foreach ($h in $hits) {{ 'RULE|' + $h.DisplayName + '|' + $h.Profile }}
# 当前活动网络类型（哪个连接能上网就是哪个）
$active = Get-NetConnectionProfile -ErrorAction SilentlyContinue |
  Where-Object {{ $_.IPv4Connectivity -ne 'Disconnected' -and $_.IPv4Connectivity -ne 'NoTraffic' }} |
  Select-Object -First 1 -ExpandProperty NetworkCategory
if ($active) {{ 'ACTIVE|' + $active }} else {{ 'ACTIVE|' }}
"#,
        // PowerShell 单引号字符串：把 exe 路径里的单引号翻倍转义
        exe = format!("'{}'", program.replace('\'', "''"))
    );

    match run_powershell(&script) {
        Some(out) => {
            let (status, rules) = evaluate(&out);
            FirewallInfo {
                status,
                program,
                rules,
                elevated,
            }
        }
        None => FirewallInfo {
            status: FirewallStatus::Unknown,
            program,
            rules: vec![],
            elevated,
        },
    }
}

/// 解析 `check()` 的 PowerShell 输出，判断放行状态与命中的规则名。
///
/// 抽成纯函数是为了能脱离 Windows 单测：输入输出都是字符串。
/// 输出格式：
///   `RULE|<规则名>|<Profile>`
///   `ACTIVE|<当前活动网络类型>`
pub fn evaluate(out: &str) -> (FirewallStatus, Vec<String>) {
    let mut rules: Vec<String> = vec![];
    let mut profiles = std::collections::BTreeSet::new();
    let mut active = String::new();
    for line in out.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("RULE|") {
            let mut it = rest.splitn(2, '|');
            let name = it.next().unwrap_or("").trim().to_string();
            let prof = it.next().unwrap_or("").trim().to_string();
            if !name.is_empty() {
                rules.push(name);
            }
            for p in prof.split(',') {
                let p = p.trim().to_ascii_lowercase();
                if !p.is_empty() {
                    profiles.insert(p);
                }
            }
        } else if let Some(rest) = line.strip_prefix("ACTIVE|") {
            active = rest.trim().to_ascii_lowercase();
        }
    }

    // 至少要有一条规则，且 profile 覆盖「当前活动网络」或为 any 才算放行。
    // 取不到活动网络类型时放宽为「有规则即可」，避免误报。
    let has_any = profiles.contains("any");
    let covers_active = active.is_empty() || has_any || profiles.contains(&active);
    let status = if !rules.is_empty() && covers_active {
        FirewallStatus::Allowed
    } else {
        FirewallStatus::Blocked
    };
    (status, rules)
}

#[cfg(not(windows))]
pub fn check() -> FirewallInfo {
    FirewallInfo {
        status: FirewallStatus::Unknown,
        program: String::new(),
        rules: vec![],
        elevated: false,
    }
}

/// 生成「放行当前程序」的提权命令（供前端以 runas 方式执行）。
///
/// 步骤：
///   1. 先删掉同名旧规则（`delete rule name=...`），避免规则堆积 / 路径过期；
///   2. 再按程序路径加一条入站 TCP 放行，覆盖所有网络配置文件（域/专用/公用）。
///
/// 返回可直接交给 `Start-Process -Verb RunAs` 的 PowerShell 脚本文本。
pub fn elevation_script() -> String {
    let program = current_program()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let name = RULE_NAME;
    format!(
        r#"$ErrorActionPreference = 'SilentlyContinue'
$exe = '{exe}'
$name = '{name}'
# 清理同名旧规则，避免指向失效路径
Remove-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
# 按程序放行（不绑端口）：改端口 / 换网络都不用重新加规则
New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Program $exe -Protocol TCP -Profile Any -ErrorAction Stop | Out-Null
"#,
        exe = program.replace('\'', "''"),
        name = name.replace('\'', "''")
    )
}

/// 执行一段 PowerShell 脚本并返回 stdout（失败返回 None）。
pub fn run_powershell(script: &str) -> Option<String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let out = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = script;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rule_name_is_non_empty_and_stable() {
        assert_eq!(RULE_NAME, "LanShare LAN Access");
    }

    #[test]
    fn elevation_script_targets_program_not_port() {
        let s = elevation_script();
        // 必须按程序放行，绝不能绑到具体端口上（否则改端口就失效）
        assert!(s.contains("-Program $exe"), "应按程序放行: {}", s);
        assert!(!s.contains("localport"), "不应绑定端口: {}", s);
        assert!(!s.contains("-LocalPort"), "不应绑定端口: {}", s);
    }

    #[test]
    fn elevation_script_removes_stale_rule_first() {
        let s = elevation_script();
        let del = s.find("Remove-NetFirewallRule").expect("应先删旧规则");
        let add = s.find("New-NetFirewallRule").expect("应加新规则");
        assert!(del < add, "删除必须排在新增之前，否则规则会重复");
    }

    #[test]
    fn elevation_script_covers_all_profiles() {
        let s = elevation_script();
        // 覆盖 域/专用/公用 三种 profile，否则换网络就连不上
        assert!(s.contains("-Profile Any"), "应覆盖所有网络类型: {}", s);
    }

    #[test]
    fn elevation_script_escapes_single_quotes_in_path() {
        // 路径含单引号时必须翻倍转义，否则 PowerShell 脚本语法错误
        let escaped = "C:\\a'b\\x.exe".replace('\'', "''");
        assert!(escaped.contains("''"));
        assert_eq!(escaped, "C:\\a''b\\x.exe");
    }

    #[test]
    fn status_serializes_to_snake_case() {
        let j = serde_json::to_string(&FirewallStatus::Blocked).unwrap();
        assert_eq!(j, "\"blocked\"");
        let j = serde_json::to_string(&FirewallStatus::Allowed).unwrap();
        assert_eq!(j, "\"allowed\"");
        let j = serde_json::to_string(&FirewallStatus::Unknown).unwrap();
        assert_eq!(j, "\"unknown\"");
    }

    #[test]
    fn current_program_points_at_this_exe() {
        // 测试二进制也应能拿到自身路径
        let p = current_program();
        assert!(p.is_some(), "应能取到当前可执行文件路径");
    }

    // ---------- evaluate：解析 + profile 覆盖判定 ----------

    #[test]
    fn evaluate_no_rule_is_blocked() {
        let (s, r) = evaluate("ACTIVE|public\n");
        assert_eq!(s, FirewallStatus::Blocked);
        assert!(r.is_empty());
    }

    #[test]
    fn evaluate_rule_covering_active_profile_is_allowed() {
        let out = "RULE|lanshare.exe|Public\nACTIVE|public\n";
        let (s, r) = evaluate(out);
        assert_eq!(s, FirewallStatus::Allowed);
        assert_eq!(r, vec!["lanshare.exe".to_string()]);
    }

    /// 这是最容易踩的坑：弹窗只放行了 Public，但当前网络是专用（Private）。
    #[test]
    fn evaluate_rule_missing_active_profile_is_blocked() {
        let out = "RULE|lanshare.exe|Public\nACTIVE|private\n";
        let (s, r) = evaluate(out);
        assert_eq!(s, FirewallStatus::Blocked, "只放行 Public 而当前是 Private，应判定未放行");
        assert_eq!(r.len(), 1, "但仍应记录到已存在的规则，便于界面展示");
    }

    #[test]
    fn evaluate_any_profile_covers_everything() {
        let out = "RULE|LanShare LAN Access|Any\nACTIVE|private\n";
        let (s, _) = evaluate(out);
        assert_eq!(s, FirewallStatus::Allowed, "-Profile Any 应覆盖任意当前网络");
    }

    #[test]
    fn evaluate_multiple_profiles_listed() {
        let out = "RULE|r|Domain,Private\nACTIVE|private\n";
        let (s, _) = evaluate(out);
        assert_eq!(s, FirewallStatus::Allowed);
    }

    /// 取不到活动网络类型时放宽为「有规则即可」，避免误报打扰用户。
    #[test]
    fn evaluate_unknown_active_profile_falls_back_to_lenient() {
        let out = "RULE|lanshare.exe|Public\nACTIVE|\n";
        let (s, _) = evaluate(out);
        assert_eq!(s, FirewallStatus::Allowed);
    }

    #[test]
    fn evaluate_ignores_blank_and_noise_lines() {
        let out = "\n  \nRULE|a|Any\r\nnoise line\nACTIVE|domain\n";
        let (s, r) = evaluate(out);
        assert_eq!(s, FirewallStatus::Allowed);
        assert_eq!(r, vec!["a".to_string()]);
    }

    #[test]
    fn check_script_queries_profiles_not_just_match() {
        // 回归保护：检测脚本必须输出 profile 信息，否则无法发现「只放行 Public」的坑
        let src = include_str!("firewall.rs");
        assert!(src.contains("'RULE|'"), "应输出 RULE| 行");
        assert!(src.contains("'ACTIVE|'"), "应输出 ACTIVE| 行");
        assert!(src.contains("Get-NetConnectionProfile"), "应查询当前活动网络类型");
    }
}
