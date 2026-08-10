"""Markdown -> print-ready HTML for the ThreatNeXus PKCERT technical dossier.

Usage: python render_html.py <source.md> <output.html>

Pipeline: parse the dossier's own `<!-- dossier-cover ... -->` front-matter block for
cover-page fields -> pull out ```diagram fences and render each as inline SVG (lib/diagram.py,
a small hand-rolled box-and-arrow layout -- no headless-browser diagram tool is installed, and
the ten diagrams in this document are all simple flow/context shapes) -> render the remaining
CommonMark+tables through markdown-it-py -> slugify every Part/subsection heading into an id ->
replace the <!-- TOC:AUTO --> marker with a real nested, linked table of contents -> wrap in one
self-contained HTML document with an inlined print stylesheet (A4, page-break-before on every
Part heading acting as its section divider, a running footer via Chrome's own header/footer
template applied later in print-to-pdf.mjs).
"""
import re
import sys
import html
import pathlib

import yaml
from markdown_it import MarkdownIt

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import diagram  # noqa: E402

DIAGRAM_RE = re.compile(r"```diagram\n(.*?)\n```", re.DOTALL)
COVER_RE = re.compile(r"<!--\s*dossier-cover\n(.*?)\n-->", re.DOTALL)
HEADING_RE = re.compile(r"^(#{2,3})\s+(.*)$", re.MULTILINE)


def slugify(text):
    text = re.sub(r"[^\w\s-]", "", text.lower())
    return re.sub(r"[\s_]+", "-", text).strip("-")


def extract_cover(md_text):
    m = COVER_RE.search(md_text)
    fields = yaml.safe_load(m.group(1))
    return fields, md_text[: m.start()] + md_text[m.end():]


def extract_diagrams(md_text):
    placeholders = {}

    def _sub(match):
        spec = yaml.safe_load(match.group(1))
        key = f"@@DIAGRAM{len(placeholders)}@@"
        placeholders[key] = diagram.render(spec)
        return key

    return DIAGRAM_RE.sub(_sub, md_text), placeholders


def build_toc(md_text):
    """Nested Part (##) / subsection (###) TOC, each entry linking to a slug id."""
    items = []
    stack = [(0, items)]
    for m in HEADING_RE.finditer(md_text):
        level = len(m.group(1))
        title = m.group(2).strip()
        if title.lower().startswith("appendices") or True:
            pass
        slug = slugify(title)
        entry = {"title": title, "slug": slug, "children": []}
        if level == 2:
            items.append(entry)
            stack = [(2, entry["children"])]
        else:
            stack[-1][1].append(entry)
    return items


def render_toc_html(items):
    out = ['<nav class="toc">']
    for part in items:
        out.append(f'<div class="toc-part"><a href="#{part["slug"]}">{html.escape(part["title"])}</a></div>')
        if part["children"]:
            out.append('<ul class="toc-sub">')
            for sub in part["children"]:
                out.append(f'<li><a href="#{sub["slug"]}">{html.escape(sub["title"])}</a></li>')
            out.append("</ul>")
    out.append("</nav>")
    return "\n".join(out)


def add_heading_ids(html_text):
    def _sub(m):
        tag, attrs, inner = m.group(1), m.group(2), m.group(3)
        slug = slugify(re.sub(r"<[^>]+>", "", inner))
        return f'<{tag} id="{slug}"{attrs}>{inner}</{tag}>'

    return re.sub(r"<(h[23])([^>]*)>(.*?)</\1>", _sub, html_text)


def render_cover(fields):
    return f"""
<section class="cover">
  <div class="cover-mark">PKCERT</div>
  <h1 class="cover-title">{html.escape(fields['title'])}</h1>
  <p class="cover-subtitle">{html.escape(fields['subtitle'])}</p>
  <p class="cover-context">{html.escape(fields['context'])}</p>
  <p class="cover-status">{html.escape(fields['status'])}</p>
  <table class="cover-meta">
    <tr><td>Document ID</td><td>{html.escape(fields['docid'])}</td></tr>
    <tr><td>Version</td><td>{html.escape(str(fields['version']))}</td></tr>
    <tr><td>Date</td><td>{html.escape(str(fields['date']))}</td></tr>
    <tr><td>Repository commit</td><td><code>{html.escape(fields['commit'])}</code></td></tr>
    <tr><td>Authoring branch</td><td><code>{html.escape(fields['branch'])}</code></td></tr>
  </table>
</section>
"""


CSS = """
@page { size: A4; margin: 20mm 18mm 22mm 18mm; }
:root {
  --ink: #0A1210; --muted: #46564D; --green: #1F7A46; --green-soft: #EAF4EC;
  --border: #D8E2DC; --paper: #FFFFFF;
}
* { box-sizing: border-box; }
body {
  font-family: "IBM Plex Sans", Arial, sans-serif; color: var(--ink); background: var(--paper);
  font-size: 10.6pt; line-height: 1.5; margin: 0;
}
code, pre, .cover-meta code { font-family: "IBM Plex Mono", "Consolas", monospace; font-size: 9.6pt; }
pre { background: #F4F6F5; border: 1px solid var(--border); border-radius: 4px; padding: 10px 12px;
  white-space: pre-wrap; word-break: break-word; }
h1, h2, h3, h4 { font-family: "IBM Plex Sans", Arial, sans-serif; color: var(--ink); font-weight: 600; }
h2 { font-size: 19pt; border-top: 3px solid var(--green); padding-top: 14px; margin-top: 0;
  page-break-before: always; }
h3 { font-size: 13.5pt; margin-top: 22px; color: var(--ink); border-bottom: 1px solid var(--border);
  padding-bottom: 3px; }
h4 { font-size: 11.5pt; margin-top: 16px; }
p { margin: 6px 0 10px; }
a { color: var(--green); text-decoration: none; }
table { border-collapse: collapse; width: 100%; margin: 10px 0 14px; font-size: 9.6pt; }
th, td { border: 1px solid var(--border); padding: 5px 7px; text-align: left; vertical-align: top; }
th { background: var(--green-soft); font-weight: 600; }
tr { page-break-inside: avoid; }
blockquote { border-left: 3px solid var(--green); margin: 10px 0; padding: 4px 14px; color: var(--muted);
  background: var(--green-soft); }
hr { border: none; border-top: 1px solid var(--border); margin: 18px 0; }
ul, ol { margin: 6px 0 10px 22px; padding: 0; }
li { margin: 2px 0; }
.diagram { margin: 14px 0; text-align: center; page-break-inside: avoid; }
.diagram svg { max-width: 100%; height: auto; }
.diagram figcaption { font-size: 9pt; color: var(--muted); margin-top: 4px; font-style: italic; }

.cover { height: 253mm; display: flex; flex-direction: column; justify-content: center;
  align-items: flex-start; page-break-after: always; }
.cover-mark { font-size: 12pt; letter-spacing: 3px; color: var(--green); font-weight: 700; margin-bottom: 40px; }
.cover-title { font-size: 30pt; margin: 0 0 6px; }
.cover-subtitle { font-size: 15pt; color: var(--muted); margin: 0 0 28px; max-width: 80%; }
.cover-context { font-size: 10.5pt; margin: 0 0 4px; }
.cover-status { font-size: 10.5pt; font-weight: 600; color: var(--green); margin: 0 0 30px; }
.cover-meta { width: 100%; max-width: 420px; font-size: 9.6pt; }
.cover-meta td:first-child { color: var(--muted); width: 40%; }

.toc { page-break-after: always; }
.toc-part { margin: 10px 0 2px; font-weight: 600; font-size: 11pt; }
.toc-sub { list-style: none; margin: 0 0 4px 18px; padding: 0; }
.toc-sub li { font-size: 9.6pt; margin: 1px 0; color: var(--muted); }
"""


def main():
    src, dst = sys.argv[1], sys.argv[2]
    pathlib.Path(dst).parent.mkdir(parents=True, exist_ok=True)
    md_text = pathlib.Path(src).read_text(encoding="utf-8")
    cover, md_text = extract_cover(md_text)
    md_text, placeholders = extract_diagrams(md_text)
    toc_items = build_toc(md_text)

    md = MarkdownIt("commonmark", {"html": True}).enable(["table", "strikethrough"])
    body_html = md.render(md_text)
    body_html = add_heading_ids(body_html)
    body_html = body_html.replace("<!-- TOC:AUTO -->", render_toc_html(toc_items))
    for key, svg in placeholders.items():
        body_html = body_html.replace(f"<p>{key}</p>", svg).replace(key, svg)

    full = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{html.escape(cover['title'])} — {html.escape(cover['subtitle'])}</title>
<style>{CSS}</style>
</head>
<body>
{render_cover(cover)}
<article>
{body_html}
</article>
</body>
</html>"""
    pathlib.Path(dst).write_text(full, encoding="utf-8")
    print(f"Wrote {dst} ({len(full)} bytes), {len(placeholders)} diagrams rendered, "
          f"{sum(1 + len(p['children']) for p in toc_items)} TOC entries.")


if __name__ == "__main__":
    main()
