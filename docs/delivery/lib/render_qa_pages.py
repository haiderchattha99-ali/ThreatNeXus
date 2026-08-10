"""Render every PDF page to PNG and pack them into contact sheets for visual QA.

Individually opening 60-70 page images would be its own bottleneck; a contact sheet of N
thumbnails per image lets every single page still get looked at, just in fewer files. Poppler
(pdftoppm) and Pillow are both already installed -- see DOSSIER_BUILD_NOTES.md.

Usage: python render_qa_pages.py <pdf> <out_dir> [pages_per_sheet]
"""
import subprocess
import sys
import pathlib
import math

from PIL import Image, ImageDraw

PAGES_PER_SHEET_DEFAULT = 8


def main():
    pdf_path = sys.argv[1]
    out_dir = pathlib.Path(sys.argv[2])
    per_sheet = int(sys.argv[3]) if len(sys.argv) > 3 else PAGES_PER_SHEET_DEFAULT
    pages_dir = out_dir / "pages"
    pages_dir.mkdir(parents=True, exist_ok=True)

    subprocess.run(
        ["pdftoppm", "-png", "-r", "110", pdf_path, str(pages_dir / "page")],
        check=True,
    )
    pages = sorted(pages_dir.glob("page-*.png"))
    if not pages:
        raise SystemExit("pdftoppm produced no pages")

    sample = Image.open(pages[0])
    tw, th = sample.size
    cols = 4
    rows = math.ceil(per_sheet / cols)
    label_h = 18
    sheet_w = tw * cols
    sheet_h = (th + label_h) * rows

    sheets_dir = out_dir / "sheets"
    sheets_dir.mkdir(exist_ok=True)
    for start in range(0, len(pages), per_sheet):
        chunk = pages[start:start + per_sheet]
        sheet = Image.new("RGB", (sheet_w, sheet_h), "white")
        draw = ImageDraw.Draw(sheet)
        for i, p in enumerate(chunk):
            img = Image.open(p)
            r, c = divmod(i, cols)
            x, y = c * tw, r * (th + label_h)
            sheet.paste(img, (x, y + label_h))
            draw.text((x + 4, y + 2), p.stem.replace("page-", "p"), fill="black")
        sheet_path = sheets_dir / f"sheet-{start // per_sheet + 1:02d}.png"
        sheet.save(sheet_path)
        print(f"Wrote {sheet_path} ({len(chunk)} pages)")

    print(f"\n{len(pages)} total pages rendered from {pdf_path}.")


if __name__ == "__main__":
    main()
