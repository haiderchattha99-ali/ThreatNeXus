"""Add a PDF outline (bookmarks) to the Chrome-printed dossier.

Chrome's print-to-PDF pipeline does not generate an outline from HTML headings, so this is a
required post-processing step, not an optional polish. Approach: re-extract the same Part/
subsection heading list render_html.py used for the on-page table of contents, then find which
physical page each heading's text first appears on by running Poppler's pdftotext one page at a
time (already installed -- see DOSSIER_BUILD_NOTES.md for the full toolchain discovery), and
build the outline with pypdf (already installed).

Usage: python add_bookmarks.py <source.md> <raw.pdf> <final.pdf>
"""
import re
import subprocess
import sys
import pathlib

from pypdf import PdfReader, PdfWriter

HEADING_RE = re.compile(r"^(#{2,3})\s+(.*)$", re.MULTILINE)
DIAGRAM_RE = re.compile(r"```diagram\n.*?\n```", re.DOTALL)
COVER_RE = re.compile(r"<!--\s*dossier-cover\n.*?\n-->", re.DOTALL)


def extract_headings(md_text):
    md_text = COVER_RE.sub("", md_text)
    md_text = DIAGRAM_RE.sub("", md_text)
    out = []
    for m in HEADING_RE.finditer(md_text):
        level = len(m.group(1))
        title = m.group(2).strip()
        out.append((level, title))
    return out


def page_text(pdf_path, page_number):
    r = subprocess.run(
        ["pdftotext", "-enc", "UTF-8", "-f", str(page_number), "-l", str(page_number), "-layout", pdf_path, "-"],
        capture_output=True, text=True, encoding="utf-8", errors="ignore",
    )
    return r.stdout


def _normalize(text):
    text = re.sub(r"[‒-―−]", "-", text)  # any dash variant -> hyphen
    text = re.sub(r"[^\w\s-]", "", text)
    return re.sub(r"\s+", " ", text).strip().lower()


def find_page(title, pdf_path, total_pages, search_hint):
    """Search forward from search_hint (monotonic headings assumption) for the heading text."""
    needle = _normalize(title)[:40]
    for p in range(search_hint, total_pages + 1):
        text = _normalize(page_text(pdf_path, p))
        if needle in text:
            return p
    return None


def main():
    md_path, raw_pdf, final_pdf = sys.argv[1], sys.argv[2], sys.argv[3]
    md_text = pathlib.Path(md_path).read_text(encoding="utf-8")
    headings = extract_headings(md_text)

    reader = PdfReader(raw_pdf)
    total = len(reader.pages)
    writer = PdfWriter()
    writer.append(reader)

    parent_stack = {}
    cursor = 1
    unresolved = []
    for level, title in headings:
        page = find_page(title, raw_pdf, total, cursor)
        if page is None:
            unresolved.append(title)
            continue
        cursor = page
        parent = parent_stack.get(2) if level == 3 else None
        item = writer.add_outline_item(title, page - 1, parent=parent)
        if level == 2:
            parent_stack[2] = item

    writer.write(final_pdf)
    print(f"Bookmarks added: {len(headings) - len(unresolved)}/{len(headings)} headings resolved to a page.")
    if unresolved:
        print("Unresolved (no bookmark, page text search failed):")
        for t in unresolved:
            print(f"  - {t}")
    print(f"Wrote {final_pdf} ({total} pages).")


if __name__ == "__main__":
    main()
