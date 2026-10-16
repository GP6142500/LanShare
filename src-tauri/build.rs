fn main() {
    // 把构建时刻注入为编译期环境变量，供「关于」面板展示。
    // 没有额外依赖：直接用系统时间做本地格式化是麻烦事，这里取 UTC 秒数交给前端格式化，
    // 同时给一个可读的 ISO 串（由 build 脚本用系统 `date` 不可移植，故手算）。
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!("cargo:rustc-env=LANSHARE_BUILD_TIME={}", secs);

    // 任何源码/配置变化都应触发重新构建，保证版本时间新鲜。
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=build.rs");

    tauri_build::build()
}
