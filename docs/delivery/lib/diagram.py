"""Tiny box-and-arrow SVG renderer for the dossier's ```diagram fences.

Not a general diagramming library: nodes sit on a fixed-size grid (each with an explicit
col/row, or auto-placed in a single row/column when a diagram is a plain chain), and edges
are straight lines from the nearer edge of the source box to the nearer edge of the target
box. That is all ten diagrams in the dossier need -- every one is a short chain, a shallow
fan-out/fan-in, or a small hub. Reach for a real diagram tool (Mermaid + a headless browser)
if a future edit needs curves, many crossing edges, or a large graph.
"""
import html
import textwrap

GREEN = "#1F7A46"
INK = "#0A1210"
MUTED = "#5B6B63"
BORDER = "#C9D6CE"
FILL = {"actor": "#EEF6F1", "system": "#FFFFFF", "store": "#F3F0E4", "external": "#F5EEE9"}

BOX_W, BOX_H, GAP_X, GAP_Y, PAD, FONT = 200, 64, 40, 40, 24, 12.5


def _wrap(label, width_chars=25):
    lines = []
    for part in label.split("\n"):
        lines.extend(textwrap.wrap(part, width_chars) or [""])
    return lines


def _box(x, y, w, h, label, kind):
    lines = _wrap(label)
    fill = FILL.get(kind, "#FFFFFF")
    ty = y + h / 2 - (len(lines) - 1) * 7.5
    text_spans = "".join(
        f'<tspan x="{x + w / 2}" y="{ty + i * 15}">{html.escape(t)}</tspan>' for i, t in enumerate(lines)
    )
    return (
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="7" '
        f'fill="{fill}" stroke="{BORDER}" stroke-width="1.5"/>'
        f'<text x="{x + w / 2}" y="{ty}" text-anchor="middle" '
        f'font-family="IBM Plex Sans, Arial, sans-serif" font-size="{FONT}" fill="{INK}">{text_spans}</text>'
    )


def _arrow_marker():
    return (
        '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" '
        'markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">'
        f'<path d="M0,0 L10,5 L0,10 z" fill="{GREEN}"/></marker>'
    )


def _connector_points(src_box, dst_box):
    """Pick the pair of box-edge midpoints nearest each other, direction-aware."""
    sx, sy, sw, sh = src_box
    dx, dy, dw, dh = dst_box
    scx, scy = sx + sw / 2, sy + sh / 2
    dcx, dcy = dx + dw / 2, dy + dh / 2
    if abs(dcx - scx) >= abs(dcy - scy):
        if scx <= dcx:
            return (sx + sw, scy), (dx, dcy)
        return (sx, scy), (dx + dw, dcy)
    if scy <= dcy:
        return (scx, sy + sh), (dcx, dy)
    return (scx, sy), (dcx, dy + dh)


def _edge(p1, p2, label=None):
    x1, y1 = p1
    x2, y2 = p2
    mx, my = (x1 + x2) / 2, (y1 + y2) / 2
    out = (
        f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{GREEN}" '
        f'stroke-width="1.5" marker-end="url(#arrow)"/>'
    )
    if label:
        w = len(label) * 5.1 + 6
        out += (
            f'<rect x="{mx - w / 2}" y="{my - 8}" width="{w}" height="13" fill="#FFFFFF" opacity="0.96"/>'
            f'<text x="{mx}" y="{my + 1.5}" text-anchor="middle" '
            f'font-family="IBM Plex Sans, Arial, sans-serif" font-size="8.3" fill="{MUTED}">{html.escape(label)}</text>'
        )
    return out


def _auto_place(nodes, direction):
    """Single row (horizontal) or single column (vertical) when no col/row is given."""
    placed = []
    for i, n in enumerate(nodes):
        if direction == "horizontal":
            col, row = i, 0
        else:
            col, row = 0, i
        placed.append({**n, "col": n.get("col", col), "row": n.get("row", row)})
    return placed


def render(spec):
    """spec: dict with keys type/title/nodes/edges/direction; nodes may set col/row explicitly."""
    default_direction = "horizontal" if spec.get("type") == "context" else "vertical"
    direction = spec.get("direction", default_direction)
    nodes = _auto_place(spec.get("nodes", []), direction)
    edges = spec.get("edges", [])

    max_col = max(n["col"] for n in nodes)
    max_row = max(n["row"] for n in nodes)
    cell_w, cell_h = BOX_W + GAP_X, BOX_H + GAP_Y
    positions = {}
    for n in nodes:
        x = PAD + n["col"] * cell_w
        y = PAD + 16 + n["row"] * cell_h
        positions[n["id"]] = (x, y, BOX_W, BOX_H)

    width = PAD * 2 + (max_col + 1) * BOX_W + max_col * GAP_X
    height = PAD * 2 + 16 + (max_row + 1) * BOX_H + max_row * GAP_Y

    body = [_arrow_marker()]
    for n in nodes:
        bx, by, bw, bh = positions[n["id"]]
        body.append(_box(bx, by, bw, bh, n["label"], n.get("kind", "system")))
    for e in edges:
        src, dst = e[0], e[1]
        label = e[2] if len(e) > 2 else None
        p1, p2 = _connector_points(positions[src], positions[dst])
        body.append(_edge(p1, p2, label))

    title = spec.get("title", "")
    # Content column is ~700 CSS px wide in the print layout; a diagram tall enough to
    # exceed one page (page-break-inside: avoid can't help once that's true) must be
    # scaled down by height, not stretched to fill the column width regardless of shape.
    COLUMN_W, MAX_H = 700, 640
    scale = min(COLUMN_W / width, MAX_H / height, 2.0)
    display_w = round(width * scale)
    svg = (
        f'<figure class="diagram">'
        f'<svg viewBox="0 0 {width} {height}" width="{display_w}" role="img" '
        f'aria-label="{html.escape(title)}" xmlns="http://www.w3.org/2000/svg" '
        f'style="max-width:100%;">'
        + "".join(body)
        + "</svg>"
        f'<figcaption>{html.escape(title)}</figcaption>'
        f"</figure>"
    )
    return svg
