//! 缩略图生成与磁盘缓存。
//!
//! 设计要点：
//!
//! - **主机面板与手机端共用**：控制面板走 320px（网格卡片），手机列表行只要 160px，
//!   由 `/api/thumb/:id?w=` 决定；两者都先落到 320px 基准缓存再降采样。
//! - **上传即预热**：上传完成后把生成任务排进后台单线程队列，打开列表时基本全是缓存命中。
//! - **同步且吃 CPU**：`generate()` 内部是纯同步的解码 + 缩放 + 编码，
//!   调用方必须放进 `spawn_blocking`，否则会卡住 tokio 工作线程。
//! - **缓存文件名带 mtime**：`<id>-<mtime>-<size>.jpg`。源文件被覆盖后
//!   mtime 变化，URL 里的版本号与缓存名同时变化，旧缓存自然失效，
//!   不需要任何主动失效逻辑；残留由启动时的 `prune_old` 回收。

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

// `dimensions()` / `orientation()` 是 trait 方法，不 import 就调不到
use image::ImageDecoder;

/// 缩略图最长边（像素）。
/// 网格卡片约 136 CSS px 宽，320 在 2x 屏下仍然清晰，单张 JPEG 约 20~30 KB。
pub const THUMB_SIZE: u32 = 320;

/// 单张图允许解码的最大像素总数。
///
/// 解码时占用内存约为 `w * h * 4` 字节，且解码器还可能额外分配。
/// 全景图 / 扫描件能到几亿像素，必须在解码**之前**用头部尺寸拦下来。
const MAX_PIXELS: u64 = 80_000_000;

/// 缓存保留天数。超期的缩略图在服务启动时清掉。
const CACHE_MAX_AGE_DAYS: u64 = 30;

/// 能出缩略图的图片扩展名（小写、不含点）。
///
/// 只列 `Cargo.toml` 里已启用解码器的格式。`heic` / `avif` / `tiff` 等
/// 不在此列 —— 它们会走系统缩略图（见下方 shell 模块），前端不会发出无效请求。
const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp", "webp"];

/// 能出缩略图的视频扩展名。交给系统缩略图服务解码，
/// 具体能不能出图取决于系统装没装对应解码器（h264 mp4 / mov 基本都行）。
const VIDEO_EXTS: &[&str] = &[
    "mp4", "m4v", "mov", "avi", "mkv", "wmv", "webm", "flv", "mpg", "mpeg", "3gp", "ts",
];

/// 是否是可由 image 直接解码的图片格式。
pub fn is_image_ext(ext: &str) -> bool {
    IMAGE_EXTS.iter().any(|e| *e == ext)
}

/// 是否是可交给系统缩略图的视频格式。
pub fn is_video_ext(ext: &str) -> bool {
    VIDEO_EXTS.iter().any(|e| *e == ext)
}

/// 是否值得请求缩略图（前端据此决定发不发 `/api/thumb`）。
pub fn can_thumb_ext(ext: &str) -> bool {
    is_image_ext(ext) || is_video_ext(ext)
}

/// 缩略图缓存目录（`%APPDATA%\lanshare\thumbs`，测试时跟随 `LANSHARE_CONFIG_DIR`）。
pub fn cache_dir() -> PathBuf {
    super::server::config_dir().join("thumbs")
}

/// 缓存文件路径：`<dir>/<id>-<mtime>-<size>.jpg`。
pub fn cache_path(dir: &Path, id: &str, mtime: i64, size: u32) -> PathBuf {
    dir.join(format!("{id}-{mtime}-{size}.jpg"))
}

/// 生成一张缩略图，返回 JPEG 字节。
///
/// 双路径分派（2B + 2C）：
///
/// 1. **视频** → 直接走系统缩略图（Windows Shell），image 无能为力；
///    系统出不了图（缺解码器）就返回 `None`，前端退化为徽章。
/// 2. **图片** → 先走 image（快、可控：不放大、白底压平、EXIF 纠正）；
///    image 解不了（HEIC / TIFF / 冷门 webp 变体 / 损坏文件）再让系统
///    解码器兜底试一次 —— 系统装的「HEVC 图像扩展」等正好补上这块覆盖。
///
/// 失败（格式不支持、文件损坏、图太大、IO 错误）统一返回 `None`，
/// 由调用方转成 404，前端据此显示类型徽章 —— 缩略图失败不该是个错误弹窗。
pub fn generate(src: &Path, size: u32) -> Option<Vec<u8>> {
    let ext = src
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    if is_video_ext(&ext) {
        return shell::generate(src, size);
    }

    match generate_image(src, size) {
        Some(bytes) => Some(bytes),
        // 只有 image 声称支持的图片才值得让系统兜底，别的类型去了也是白跑
        None if is_image_ext(&ext) => shell::generate(src, size),
        None => None,
    }
}

/// image crate 路径：解码 → EXIF 纠正 → 缩放 → JPEG。
fn generate_image(src: &Path, size: u32) -> Option<Vec<u8>> {
    let reader = image::ImageReader::open(src)
        .ok()?
        .with_guessed_format()
        .ok()?;
    let mut decoder = reader.into_decoder().ok()?;

    // 先看头部尺寸再决定是否解码：这一步只读元数据，几乎不耗内存。
    let (w, h) = decoder.dimensions();
    if w == 0 || h == 0 || (w as u64) * (h as u64) > MAX_PIXELS {
        return None;
    }

    // 手机照片普遍用 EXIF Orientation 表示旋转，不应用的话缩略图会横躺。
    // 解码器不支持时按「无变换」处理，不影响主流程。
    let orient = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);

    let mut img = image::DynamicImage::from_decoder(decoder).ok()?;
    img.apply_orientation(orient);

    // thumbnail() 在「源图比目标小」时**会放大**（image 0.25 的实现并不只缩不放），
    // 小图标放大后只会变糊。小于目标边长时原样保留，显示尺寸交给前端 object-fit。
    let thumb = if img.width() <= size && img.height() <= size {
        img
    } else {
        img.thumbnail(size, size)
    };

    // JPEG 不支持 alpha：直接 to_rgb8() 会把透明区域变成黑色。
    // 先铺一层白底再压平，深色 PNG 图标才不会被啃成黑块。
    let rgba = thumb.to_rgba8();
    let (tw, th) = rgba.dimensions();
    let mut canvas = image::RgbaImage::from_pixel(tw, th, image::Rgba([255, 255, 255, 255]));
    image::imageops::overlay(&mut canvas, &rgba, 0, 0);
    let rgb = image::DynamicImage::ImageRgba8(canvas).to_rgb8();

    let mut out = Vec::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82);
    enc.encode_image(&rgb).ok()?;
    Some(out)
}

/// 取一张指定宽度的缩略图，负责「缓存 → 降采样」的完整链路。
///
/// 策略：
/// 1. 目标宽度的缓存存在 → 直接返回；
/// 2. 否则确保 320px 基准缓存存在（不存在就解码原图生成）；
/// 3. 目标宽度 < 320 → 从基准缓存降采样。解码一张 320px JPEG 约 2ms，
///    而解码一张 12MP 原图要 80~300ms —— 手机列表行要 160px 时这个差别很明显。
///
/// 同步 CPU 密集，调用方必须放进 `spawn_blocking`。
pub fn ensure(dir: &Path, src: &Path, id: &str, mtime: i64, want: u32) -> Option<Vec<u8>> {
    if want >= THUMB_SIZE {
        return Some(base_bytes(dir, src, id, mtime)?);
    }

    let target = cache_path(dir, id, mtime, want);
    if let Ok(b) = std::fs::read(&target) {
        return Some(b);
    }
    let base = base_bytes(dir, src, id, mtime)?;
    let small = shrink(&base, want)?;
    // 写失败不影响本次返回
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(&target, &small);
    Some(small)
}

/// 320px 基准缓存：有则读，无则生成并落盘。
fn base_bytes(dir: &Path, src: &Path, id: &str, mtime: i64) -> Option<Vec<u8>> {
    let base = cache_path(dir, id, mtime, THUMB_SIZE);
    if let Ok(b) = std::fs::read(&base) {
        return Some(b);
    }
    let bytes = generate(src, THUMB_SIZE)?;
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(&base, &bytes);
    Some(bytes)
}

/// 把已有的 320px JPEG 缩到 `size` 以内（只缩不放）。
fn shrink(jpeg: &[u8], size: u32) -> Option<Vec<u8>> {
    let img = image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg).ok()?;
    let small = if img.width() <= size && img.height() <= size {
        img
    } else {
        img.thumbnail(size, size)
    };
    let rgb = small.to_rgb8();
    let mut out = Vec::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80);
    enc.encode_image(&rgb).ok()?;
    Some(out)
}

// ---------------------------- 上传即预热 ----------------------------
// 打开列表时每张图都现场解码，会让人感觉「缩略图慢慢冒出来」。
// 上传完成时把生成任务丢进后台队列，等用户打开列表时缓存已经就绪。
// 用**单线程串行**而不是并发：一次上传 50 张照片时，50 个并发解码会把
// CPU 打满（反而拖慢上传响应），串行 54ms/张 在后台完全够用。

struct WarmJob {
    src: PathBuf,
    cache: PathBuf,
}

static WARM_TX: std::sync::OnceLock<std::sync::mpsc::Sender<WarmJob>> = std::sync::OnceLock::new();

fn warm_queue() -> &'static std::sync::mpsc::Sender<WarmJob> {
    WARM_TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<WarmJob>();
        // 线程创建失败也不致命：tx 还在，任务只会堆积不被消费，不影响主流程
        let _ = std::thread::Builder::new()
            .name("lanshare-thumb".into())
            .spawn(move || {
                for job in rx {
                    // 可能已被在线请求生成过，重复时直接跳过
                    if job.cache.exists() {
                        continue;
                    }
                    if let Some(parent) = job.cache.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    if let Some(bytes) = generate(&job.src, THUMB_SIZE) {
                        let _ = std::fs::write(&job.cache, bytes);
                    }
                }
            });
        tx
    })
}

/// 把某个文件的缩略图生成排进后台队列（不阻塞调用方）。
pub fn warm(dir: &Path, src: &Path, id: &str, mtime: i64) {
    let _ = warm_queue().send(WarmJob {
        src: src.to_path_buf(),
        cache: cache_path(dir, id, mtime, THUMB_SIZE),
    });
}

/// 删除某个文件 id 的全部缓存（文件名以 `<id>-` 开头）。

/// 删除源文件时调用，避免缓存越积越多。
pub fn remove_for(dir: &Path, id: &str) -> usize {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    let prefix = format!("{id}-");
    let mut n = 0;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with(&prefix) && std::fs::remove_file(e.path()).is_ok() {
            n += 1;
        }
    }
    n
}

/// 清空缓存目录里的全部文件（保留目录本身）。
/// 「清空全部历史文件」时调用 —— 那时所有缩略图都已失去引用方。
pub fn purge(dir: &Path) -> usize {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut n = 0;
    for e in rd.flatten() {
        if e.path().is_file() && std::fs::remove_file(e.path()).is_ok() {
            n += 1;
        }
    }
    n
}

/// 清理超过 `CACHE_MAX_AGE_DAYS` 天的缓存文件。
///
/// 源文件被删除、或被同名覆盖后，旧缓存的文件名不再被引用，只能靠年龄回收。
/// 服务启动时调用一次即可（放在 spawn_blocking 里，别阻塞启动）。
pub fn prune_old(dir: &Path) -> usize {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(CACHE_MAX_AGE_DAYS * 24 * 3600))
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let mut n = 0;
    for e in rd.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        if meta.modified().map(|t| t < cutoff).unwrap_or(false)
            && std::fs::remove_file(e.path()).is_ok()
        {
            n += 1;
        }
    }
    n
}

// ---------------------------- 系统缩略图（2C 路径） ----------------------------
// 交给 Windows Shell 拿资源管理器同款缩略图：
// 视频靠系统解码器（h264 mp4/mov 基本都行），HEIC/TIFF 等 image 解不了的
// 图片也能借「HEVC 图像扩展」之类补上。`windows` 本来就是 wry 的传递依赖，
// 显式启用 feature 不新增 crate。失败一律安静地返回 None，绝不 panic。

#[cfg(windows)]
mod shell {
    use std::path::Path;

    use windows::core::HSTRING;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC,
        SelectObject, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_RESIZETOFIT,
        SIIGBF_THUMBNAILONLY,
    };

    /// 在当前线程初始化 COM（MTA），每个线程只做一次。
    ///
    /// 调用方是预热线程与 `spawn_blocking` 工作线程，都没有消息泵，
    /// 用 STA 反而有跨套间回调死锁的风险 —— MTA 下 Shell 的缩略图服务
    /// 工作正常（已实测）。返回 S_FALSE / RPC_E_CHANGED_MODE 说明线程
    /// 上已有套间，直接复用即可，都不需要配对 `CoUninitialize`
    ///（线程随进程存活，回收交给系统）。
    fn ensure_com() {
        thread_local! {
            static DONE: bool = {
                let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
                true
            };
        }
        DONE.with(|_| {});
    }

    /// 让 Shell 出一张缩略图并编码为 JPEG。
    ///
    /// `SIIGBF_THUMBNAILONLY` 保证拿到的是**真实画面帧**而不是文件类型图标；
    /// 系统没装解码器时该调用失败，正好走兜底/徽章，不会给出一张假图。
    pub(super) fn generate(src: &Path, size: u32) -> Option<Vec<u8>> {
        ensure_com();
        // HSTRING 而不是 to_wide 手搓：保证 NUL 结尾与 UTF-16 编码正确
        let path = HSTRING::from(src.as_os_str().to_string_lossy().to_string());
        unsafe {
            let factory: IShellItemImageFactory = SHCreateItemFromParsingName(&path, None).ok()?;
            let hbmp = factory
                .GetImage(
                    SIZE {
                        cx: size as i32,
                        cy: size as i32,
                    },
                    SIIGBF_THUMBNAILONLY | SIIGBF_RESIZETOFIT,
                )
                .ok()?;

            let out = hbmp_to_jpeg(hbmp);
            let _ = DeleteObject(hbmp.into());
            out
        }
    }

    /// HBITMAP → BGRA 像素 → JPEG。失败返回 None（bitmp 无论如何都会被释放）。
    unsafe fn hbmp_to_jpeg(hbmp: windows::Win32::Graphics::Gdi::HBITMAP) -> Option<Vec<u8>> {
        let mut bm = BITMAP::default();
        let got = GetObjectW(
            hbmp.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut _ as *mut _),
        );
        if got == 0 {
            return None;
        }
        let w = bm.bmWidth as u32;
        let h = bm.bmHeight as u32;
        if w == 0 || h == 0 {
            return None;
        }

        // 请求 32bpp 顶行在前的 DIB：负 biHeight = top-down，省一次翻转
        let mut bi = BITMAPINFO::default();
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = w as i32;
        bi.bmiHeader.biHeight = -(h as i32);
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = 0; // BI_RGB

        let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let old = SelectObject(mem, hbmp.into());
        let lines = GetDIBits(
            mem,
            hbmp,
            0,
            h,
            Some(buf.as_mut_ptr() as *mut _),
            &mut bi,
            DIB_RGB_COLORS,
        );
        SelectObject(mem, old);
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        if lines == 0 {
            return None;
        }

        // GetDIBits 给的是 BGRA；高位字节是垃圾值，顺手强制不透明
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }
        let img = image::RgbaImage::from_raw(w, h, buf)?;
        let mut out = Vec::new();
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82);
        enc.encode_image(&image::DynamicImage::ImageRgba8(img).to_rgb8())
            .ok()?;
        Some(out)
    }
}

/// 非 Windows 没有 Shell 缩略图：视频直接退徽章，图片仍走 image 路径。
#[cfg(not(windows))]
mod shell {
    use std::path::Path;

    pub(super) fn generate(_src: &Path, _size: u32) -> Option<Vec<u8>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_ext_matches_case_sensitively_after_lowercase() {
        assert!(is_image_ext("jpg"));
        assert!(is_image_ext("jpeg"));
        assert!(is_image_ext("png"));
        assert!(is_image_ext("gif"));
        assert!(is_image_ext("bmp"));
        assert!(is_image_ext("webp"));
        // 调用方负责转小写；这里验证不会「顺手」通过
        assert!(!is_image_ext("JPG"));
        assert!(!is_image_ext("heic"));
        assert!(!is_image_ext("pdf"));
        assert!(!is_image_ext(""));
    }

    #[test]
    fn video_ext_matches_lowercase_only() {
        assert!(is_video_ext("mp4"));
        assert!(is_video_ext("mkv"));
        assert!(is_video_ext("mov"));
        assert!(!is_video_ext("MP4"), "调用方负责转小写");
        assert!(!is_video_ext("jpg"), "图片不属于视频");
        assert!(!is_video_ext(""));
    }

    #[test]
    fn can_thumb_ext_covers_images_and_videos() {
        for e in ["jpg", "png", "webp", "mp4", "mkv", "avi"] {
            assert!(can_thumb_ext(e), "{e} 应该可以出缩略图");
        }
        for e in ["pdf", "txt", "zip", "heic", ""] {
            assert!(!can_thumb_ext(e), "{e} 不应该请求缩略图");
        }
    }

    #[test]
    fn cache_path_is_unique_per_mtime() {
        let dir = Path::new("C:/tmp/thumbs");
        let a = cache_path(dir, "abc", 100, 320);
        let b = cache_path(dir, "abc", 101, 320);
        assert_ne!(a, b, "mtime 变了必须换文件名，否则旧缓存会盖住新图");
        assert!(a.ends_with("abc-100-320.jpg"));
    }

    #[test]
    fn generate_returns_none_for_missing_file() {
        assert!(generate(Path::new("C:/definitely/not/here.jpg"), 320).is_none());
    }

    #[test]
    fn generate_returns_none_for_non_image_bytes() {
        // 扩展名是 .jpg 但内容不是图片：必须安静地失败，不能 panic
        let dir = std::env::temp_dir().join("lanshare-thumb-test");
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("fake.jpg");
        std::fs::write(&p, b"this is not an image at all").unwrap();
        assert!(generate(&p, 320).is_none());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn generate_produces_jpeg_for_real_image() {
        // 用 image 自己编码一张 64x64 的 PNG，再让 generate 读回来
        let dir = std::env::temp_dir().join("lanshare-thumb-test");
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("real.png");
        let mut rgba = image::RgbaImage::new(64, 64);
        for (x, y, px) in rgba.enumerate_pixels_mut() {
            *px = image::Rgba([(x * 4) as u8, (y * 4) as u8, 128, 255]);
        }
        image::DynamicImage::ImageRgba8(rgba).save(&p).unwrap();

        let out = generate(&p, 32).expect("应能生成缩略图");
        // JPEG 魔数 FF D8 FF
        assert_eq!(&out[..3], &[0xFF, 0xD8, 0xFF]);
        assert!(out.len() > 100);

        // 输出尺寸不超过请求的边长
        let dim = image::ImageReader::new(std::io::Cursor::new(&out))
            .with_guessed_format()
            .unwrap()
            .into_dimensions()
            .unwrap();
        assert!(dim.0 <= 32 && dim.1 <= 32, "缩略图不应超过 32px: {:?}", dim);

        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn generate_does_not_upscale_small_images() {
        // image 0.25 的 thumbnail() 对小图会放大，这里锁住「不放大」的行为
        let dir = std::env::temp_dir().join("lanshare-thumb-test");
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("small.png");
        let img = image::RgbaImage::from_pixel(24, 16, image::Rgba([10, 120, 200, 255]));
        image::DynamicImage::ImageRgba8(img).save(&p).unwrap();

        let out = generate(&p, 320).expect("小图也应能生成");
        let dim = image::ImageReader::new(std::io::Cursor::new(&out))
            .with_guessed_format()
            .unwrap()
            .into_dimensions()
            .unwrap();
        assert!(dim.0 <= 24 && dim.1 <= 16, "小图不该被放大: {:?}", dim);

        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn ensure_writes_base_and_small_variant() {
        // 手机列表行只要 160px：应当先落 320 基准缓存，再降采样出 160 的一档
        let dir = std::env::temp_dir().join("lanshare-thumb-ensure");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let src = dir.join("big.png");
        let img = image::RgbaImage::from_pixel(800, 600, image::Rgba([30, 140, 200, 255]));
        image::DynamicImage::ImageRgba8(img).save(&src).unwrap();

        let small = ensure(&dir, &src, "id1", 123, 160).expect("应能生成 160px");
        let dim = image::ImageReader::new(std::io::Cursor::new(&small))
            .with_guessed_format()
            .unwrap()
            .into_dimensions()
            .unwrap();
        assert_eq!(dim, (160, 120), "800x600 缩到 160 应为 160x120");

        assert!(cache_path(&dir, "id1", 123, THUMB_SIZE).exists(), "应落 320 基准缓存");
        assert!(cache_path(&dir, "id1", 123, 160).exists(), "应落 160 缓存");

        // 再来一次：命中缓存，内容一致
        let again = ensure(&dir, &src, "id1", 123, 160).unwrap();
        assert_eq!(again, small, "第二次应从缓存返回同样的字节");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_default_size_returns_base_without_small_variant() {
        let dir = std::env::temp_dir().join("lanshare-thumb-ensure2");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let src = dir.join("p.png");
        let img = image::RgbaImage::from_pixel(400, 400, image::Rgba([200, 60, 60, 255]));
        image::DynamicImage::ImageRgba8(img).save(&src).unwrap();

        let bytes = ensure(&dir, &src, "id2", 7, THUMB_SIZE).expect("应能生成 320px");
        assert_eq!(&bytes[..3], &[0xFF, 0xD8, 0xFF]);
        assert!(cache_path(&dir, "id2", 7, THUMB_SIZE).exists());
        // 只要 320 时不该额外产生别的尺寸
        let n = std::fs::read_dir(&dir).unwrap().filter(|e| {
            e.as_ref().map(|x| x.file_name().to_string_lossy().ends_with(".jpg")).unwrap_or(false)
        }).count();
        assert_eq!(n, 1, "不应生成多余尺寸的缓存");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_for_only_touches_matching_id() {        let dir = std::env::temp_dir().join("lanshare-thumb-rm");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("abc-1-320.jpg"), b"x").unwrap();
        std::fs::write(dir.join("abc-2-320.jpg"), b"x").unwrap();
        std::fs::write(dir.join("abcd-1-320.jpg"), b"x").unwrap(); // 前缀不同，别误删

        assert_eq!(remove_for(&dir, "abc"), 2);
        assert!(!dir.join("abc-1-320.jpg").exists());
        assert!(dir.join("abcd-1-320.jpg").exists(), "abcd 不该被 abc 的前缀误伤");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
