//! 缩略图生成与磁盘缓存。
//!
//! 设计要点：
//!
//! - **只为主机面板服务**。生成的图给控制面板的网格视图用；设备端仍只走
//!   `/api/files`（不带 path），不会请求缩略图。
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

/// 能出缩略图的扩展名（小写、不含点）。
///
/// 只列 `Cargo.toml` 里已启用解码器的格式。`heic` / `avif` / `tiff` 等
/// 不在此列 —— 前端会退化成类型徽章，不会发出无效请求。
const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp", "webp"];

/// 是否是可生成缩略图的图片格式。
pub fn is_image_ext(ext: &str) -> bool {
    IMAGE_EXTS.iter().any(|e| *e == ext)
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
/// 失败（格式不支持、文件损坏、图太大、IO 错误）统一返回 `None`，
/// 由调用方转成 404，前端据此显示类型徽章 —— 缩略图失败不该是个错误弹窗。
pub fn generate(src: &Path, size: u32) -> Option<Vec<u8>> {
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
    fn remove_for_only_touches_matching_id() {
        let dir = std::env::temp_dir().join("lanshare-thumb-rm");
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
