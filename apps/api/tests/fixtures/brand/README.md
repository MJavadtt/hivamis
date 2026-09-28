# Brand-check fixtures (roadmap #43)

One 96×64 design — left half navy `#1A2B3C` with a 16-pixel teal `#0F766E` band at the bottom,
right half gold `#D4AF37` — encoded by real encoders, so the JPEG reader is tested against what
designers' tools write rather than against itself:

| File | Encoder |
|---|---|
| `baseline.jpg` | Pillow 11, quality 90, 4:2:0 |
| `progressive.jpg` | Pillow, `progressive=True` |
| `restart.jpg` | Pillow, `restart_marker_blocks=2` (11 RST markers) |
| `gray.jpg` | Pillow, mode `L` |
| `cmyk.jpg` | Pillow, mode `CMYK` (naive conversion; Adobe marker, transform 0) |
| `sips-cmyk.jpg` | macOS `sips` with the Generic CMYK profile; its embedded ICC profile (APP2) removed to keep the file small |

Pillow reads `sips-cmyk.jpg` as ink navy (227, 172, 94, 130), gold (14, 50, 233, 25), teal
(218, 57, 125, 46) out of 255 — the values the test expects in percent.
