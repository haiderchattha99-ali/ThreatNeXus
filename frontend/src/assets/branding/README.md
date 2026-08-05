# Branding assets

## `pkcert-logo-original.png`

| | |
|---|---|
| **Original source path** | `C:\Users\LENOVO\Documents\Codex\2026-08-03\referenced-chatgpt-conversation-this-is-an\outputs\pkcert-logo.png` |
| **Repository path** | `frontend/src/assets/branding/pkcert-logo-original.png` |
| **Authorization** | Supplied by Muhammad Ismail on 3 August 2026 specifically for use in the ThreatNeXus prototype frontend. |
| **SHA-256** | `C4A5EE9194B436A7E776B0F4C68367C0AFD9CBE379608FD3606F3308920FF9E3` |
| **Byte-identical to source** | Yes — copied verbatim, 122,545 bytes. Not redrawn, traced, recoloured, stretched or regenerated. |
| **Transparent derivative** | **Not created.** See below. |

### Why no transparent derivative was produced

The supplied PNG is a dark-green emblem on an **opaque white field** with a thin
black border. A background watermark needs transparency, and the Phase 6 brief
permits a derivative *only if it can be produced without altering the emblem or
the "PKCERT" lettering*. It cannot be, here, for two concrete reasons:

1. **The emblem contains white interior detail.** The shield's four quadrants
   carry white negative space inside the artwork itself. Any white-keying pass
   that removes the background also punches through those interior areas — that
   is an alteration of the emblem, not a background removal.
2. **The edges are anti-aliased against white.** Every boundary pixel is a
   green/white blend. Keying them out leaves either a white halo or a green
   fringe; compensating for it means repainting edge pixels, which again changes
   the artwork.

Rejecting the derivative is the outcome the brief asks for in this situation
("reject it if edges, symbols, proportions or lettering change"), so no
low-opacity background watermark is used anywhere in the application.

### Where the asset is used

| Surface | Treatment | Alt text |
|---|---|---|
| Login branding card | Original PNG inside a deliberate white container sized to the artwork, aspect ratio preserved | `"PKCERT — Pakistan Computer Emergency Response Team"` (conveys identity) |
| Settings → About / project context | Same white container, smaller | Same as above |

The logo is **not** placed behind tables, forms, evidence or small text, and it
is not used as a page background at any opacity.

### What this asset does not mean

Possession and display of the logo records the internship context only. It is
**not** evidence of PKCERT/NCERT endorsement, certification, production approval
or operational deployment of ThreatNeXus. Every surface that shows it also
carries the approved positioning line:

> Developed during an internship with PKCERT/NCERT as a defensive cybersecurity
> research and prototype platform.

### Inserting an authorized transparent asset later

`components/ui/Brand.jsx` exposes a `PkcertAttribution` component with a single
`variant` prop. To adopt an authorized transparent version:

1. Add the file as `pkcert-logo-transparent.png` in this directory and record its
   authorization and SHA-256 in the table above.
2. Import it in `Brand.jsx` and pass it where `variant="watermark"` is handled —
   the branch already exists and currently renders the text-only treatment.
3. Keep the watermark at 3–5% opacity, restricted to the login surface, the
   dashboard shell or a spacious high-level header, and never behind evidence.
