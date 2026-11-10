#!/usr/bin/env python3
"""Regenerate the frozen contract images used by the eval cases.

Every case owns one page under `fixtures/<case-id>/page-1.png`, plus a
`truth.txt` holding the exact text that was rendered. The runner uses
truth.txt to catch `auditDesc` values that were never in the contract.

These are clean synthetic pages: they test reading, anchoring, table pairing
and output discipline. They do NOT test handwriting, rotation or blurry
scans. Add real scans as extra pages when you have them.

Usage:
    python3 evals/make_fixtures.py            # regenerate everything
    python3 evals/make_fixtures.py --case 05  # one case
"""

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("需要 Pillow：python3 -m pip install pillow")

EVALS = Path(__file__).resolve().parent
FIXTURES = EVALS / "fixtures"

WIDTH, HEIGHT = 1654, 2339
MARGIN = 150
INK = "#101010"
RULE = "#5a5a5a"

FONT_CANDIDATES = [
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
]


def find_font():
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return path
    sys.exit("找不到中文字体，请把字体路径加到 FONT_CANDIDATES")


FONT_PATH = find_font()
_cache = {}


def font(size, bold=False):
    key = (size, bold)
    if key not in _cache:
        _cache[key] = ImageFont.truetype(FONT_PATH, size)
    return _cache[key]


def wrap(draw, text, fnt, max_width):
    lines, current = [], ""
    for ch in text:
        probe = current + ch
        if draw.textlength(probe, font=fnt) <= max_width or not current:
            current = probe
        else:
            lines.append(current)
            current = ch
    if current:
        lines.append(current)
    return lines


def draw_paragraph(draw, block, y):
    size = block.get("size", 34)
    fnt = font(size, block.get("bold", False))
    line_height = int(size * 1.75)
    for line in wrap(draw, block["text"], fnt, WIDTH - 2 * MARGIN):
        draw.text((MARGIN, y), line, font=fnt, fill=INK)
        y += line_height
    return y + block.get("gap", 26)


def draw_table(draw, block, y):
    headers = block["headers"]
    rows = block["rows"]
    widths = block.get("widths") or [1] * len(headers)
    total = WIDTH - 2 * MARGIN
    col_widths = [int(total * w / sum(widths)) for w in widths]
    fnt = font(30)
    pad = 16
    row_height = 78

    def cell_lines(text, width):
        return wrap(draw, text, fnt, width - 2 * pad)

    for row in [headers] + rows:
        height = row_height
        x = MARGIN
        for text, width in zip(row, col_widths):
            lines = cell_lines(text, width)
            height = max(height, len(lines) * 42 + 2 * pad)
            draw.rectangle([x, y, x + width, y + height], outline=RULE, width=2)
            ty = y + pad
            for line in lines:
                draw.text((x + pad, ty), line, font=fnt, fill=INK)
                ty += 42
            x += width
        y += height
    return y + 34


PAGES = {
    "01-baseline-pass": [
        {"type": "p", "text": "销售协议", "size": 54, "bold": True, "gap": 48},
        {"type": "p", "text": "合同编号：EV-2026-001"},
        {"type": "p", "text": "甲方（供货方）：河南和之也商贸有限公司"},
        {"type": "p", "text": "乙方（购货方）：齐齐哈尔家庭烤肉（心怡路）"},
        {"type": "p", "text": "销售合作方式：完全包量"},
        {"type": "p", "text": "预计终端投入：21015元"},
    ],
    "02-mismatch-single": [
        {"type": "p", "text": "销售协议", "size": 54, "bold": True, "gap": 48},
        {"type": "p", "text": "合同编号：EV-2026-002"},
        {"type": "p", "text": "甲方（供货方）：河南和之也商贸有限公司"},
        {"type": "p", "text": "乙方（购货方）：齐齐哈尔家庭烤肉（心怡路）"},
    ],
    "03-backfill-trap": [
        {"type": "p", "text": "销售协议", "size": 54, "bold": True, "gap": 48},
        {"type": "p", "text": "合同编号：EV-2026-003"},
        {"type": "p", "text": "甲方（供货方）：河南和之也商贸有限公司"},
        {"type": "p", "text": "乙方（购货方）："},
        {"type": "p", "text": "销售合作方式：完全包量"},
    ],
    "04-date-normalize": [
        {"type": "p", "text": "销售协议", "size": 54, "bold": True, "gap": 48},
        {"type": "p", "text": "合同编号：EV-2026-004"},
        {"type": "p", "text": "甲方（供货方）：河南和之也商贸有限公司"},
        {"type": "p", "text": "有效期间自 2024年07月23日 至 2025年06月30日止"},
    ],
    "05-table-row": [
        {"type": "p", "text": "销售协议", "size": 54, "bold": True, "gap": 48},
        {"type": "p", "text": "合同编号：EV-2026-005"},
        {"type": "p", "text": "甲方（供货方）：河南和之也商贸有限公司"},
        {"type": "p", "text": "2.1乙方经销啤酒的品种、规格、价格以及数量等。"},
        {
            "type": "table",
            "headers": ["产品品种", "进店价（元/件）"],
            "rows": [
                ["雪花纯生8度500ml白瓶1*12纸箱", "85"],
                ["勇闯天涯500ml罐装1*24", "66"],
            ],
            "widths": [3, 1],
        },
    ],
    "06-no-judgement": [
        {"type": "p", "text": "销售协议", "size": 54, "bold": True, "gap": 48},
        {"type": "p", "text": "合同编号：EV-2026-006"},
        {"type": "p", "text": "甲方（供货方）：河南和之也商贸有限公司"},
        {"type": "p", "text": "预计终端投入：21015元"},
        {"type": "p", "text": "随量折扣：无"},
        {"type": "p", "text": "固定折扣：无"},
    ],
    "07-output-discipline": [
        {"type": "p", "text": "销售协议", "size": 54, "bold": True, "gap": 48},
        {"type": "p", "text": "合同编号：EV-2026-007"},
        {"type": "p", "text": "甲方（供货方）：河南和之也商贸有限公司"},
        {"type": "p", "text": "销售合作方式：完全包量"},
    ],
    "08-fieldcode-verbatim": [
        {"type": "p", "text": "销售协议", "size": 54, "bold": True, "gap": 48},
        {"type": "p", "text": "合同编号：EV-2026-008"},
        {"type": "p", "text": "甲方（供货方）：河南和之也商贸有限公司"},
        {"type": "p", "text": "其他折扣：无"},
        {"type": "p", "text": "随量折扣：无"},
        {"type": "p", "text": "固定折扣：无"},
    ],
}


def render(blocks, out_path):
    img = Image.new("RGB", (WIDTH, HEIGHT), "white")
    draw = ImageDraw.Draw(img)
    y = 200
    truth = []
    for block in blocks:
        if block["type"] == "p":
            y = draw_paragraph(draw, block, y)
            truth.append(block["text"])
        else:
            y = draw_table(draw, block, y)
            truth.append("\t".join(block["headers"]))
            truth.extend("\t".join(row) for row in block["rows"])
    img.save(out_path)
    return "\n".join(truth) + "\n"


def main():
    ap = argparse.ArgumentParser(description="Regenerate eval fixtures")
    ap.add_argument("--case", help="只生成 id 前缀匹配的用例")
    args = ap.parse_args()

    written = 0
    for case_id, blocks in PAGES.items():
        if args.case and not case_id.startswith(args.case):
            continue
        target = FIXTURES / case_id
        target.mkdir(parents=True, exist_ok=True)
        truth = render(blocks, target / "page-1.png")
        (target / "truth.txt").write_text(truth, encoding="utf-8")
        written += 1
        print(f"wrote {target.relative_to(EVALS)}")
    print(f"{written} fixture set(s) regenerated with {FONT_PATH}")


if __name__ == "__main__":
    main()
