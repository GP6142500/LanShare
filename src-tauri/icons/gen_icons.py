import zlib, struct, os

ACCENT = (79, 70, 229, 255)
RING = (255, 255, 255, 255)


def png_bytes(size):
    w = h = size
    raw = bytearray()
    cx = cy = size / 2.0
    r = size * 0.30
    rw = max(2.0, size * 0.10)
    for y in range(h):
        raw.append(0)
        for x in range(w):
            d = ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) ** 0.5
            if abs(d - r) <= rw / 2.0:
                raw += bytes(RING)
            else:
                raw += bytes(ACCENT)
    comp = zlib.compress(bytes(raw), 9)

    def chunk(typ, data):
        c = typ + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", comp) + chunk(b"IEND", b"")


def write_png(path, size):
    with open(path, "wb") as f:
        f.write(png_bytes(size))


base = "C:/Users/高鹏/WorkBuddy/2026-10-15-11-24-28/lanshare/src-tauri/icons"
write_png(base + "/32x32.png", 32)
write_png(base + "/128x128.png", 128)
write_png(base + "/128x128@2x.png", 256)


def write_ico(path, sizes):
    pngs = [png_bytes(s) for s in sizes]
    out = bytearray()
    out += struct.pack("<HHH", 0, 1, len(pngs))
    offset = 6 + 16 * len(pngs)
    for s, p in zip(sizes, pngs):
        b = 0 if s >= 256 else s
        out += struct.pack("<BBBBHHII", b, b, 0, 0, 1, 32, len(p), offset)
        offset += len(p)
    for p in pngs:
        out += p
    with open(path, "wb") as f:
        f.write(bytes(out))


write_ico(base + "/icon.ico", [32, 48, 256])


def write_icns(path):
    p = png_bytes(128)
    entry = b"ic07" + struct.pack(">I", len(p)) + p
    data = b"icns" + struct.pack(">I", len(entry) + 4) + entry
    with open(path, "wb") as f:
        f.write(data)


write_icns(base + "/icon.icns")
print("icons generated")
