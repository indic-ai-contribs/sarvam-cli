#!/usr/bin/env python3
"""Generate docs/architecture-{light,dark}.svg — the agent loop diagram.

Both variants share this geometry so they can't drift apart. Output is fully
self-contained: no external fonts, no scripts, no remote references, since
GitHub sanitises those and the image would silently break.

Usage:  python3 scripts/make-architecture-svg.py
"""
import pathlib

W, H = 880, 384

SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"

THEMES = {
    "light": dict(
        fg="#1f2328", muted="#59636e", box="#f6f8fa", stroke="#d1d9e0",
        accent="#0969da", gate="#9a6700", gate_bg="#fff8c5", gate_stroke="#d4a72c",
        tool="#1a7f37", arrow="#818b98",
    ),
    "dark": dict(
        fg="#e6edf3", muted="#9198a1", box="#161b22", stroke="#3d444d",
        accent="#4493f8", gate="#d29922", gate_bg="#2d2611", gate_stroke="#6b5a1f",
        tool="#3fb950", arrow="#6e7681",
    ),
}


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def box(x, y, w, h, title, sub, t, fill=None, stroke=None, title_fill=None, mono=False):
    fill = fill or t["box"]
    stroke = stroke or t["stroke"]
    title_fill = title_fill or t["fg"]
    fam = MONO if mono else SANS
    out = [
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" '
        f'fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>'
    ]
    cx = x + w / 2
    if sub:
        out.append(
            f'<text x="{cx}" y="{y + h/2 - 4}" text-anchor="middle" font-family="{fam}" '
            f'font-size="15" font-weight="600" fill="{title_fill}">{esc(title)}</text>'
        )
        out.append(
            f'<text x="{cx}" y="{y + h/2 + 16}" text-anchor="middle" font-family="{MONO}" '
            f'font-size="11.5" fill="{t["muted"]}">{esc(sub)}</text>'
        )
    else:
        out.append(
            f'<text x="{cx}" y="{y + h/2 + 5}" text-anchor="middle" font-family="{fam}" '
            f'font-size="15" font-weight="600" fill="{title_fill}">{esc(title)}</text>'
        )
    return "\n  ".join(out)


def label(x, y, text, t, anchor="middle", color=None, size=11.5):
    return (
        f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-family="{MONO}" '
        f'font-size="{size}" fill="{color or t["muted"]}">{esc(text)}</text>'
    )


def build(name, t):
    p = []

    # ---- nodes -------------------------------------------------------------
    p.append(box(24, 78, 96, 60, "You", None, t))
    p.append(box(160, 62, 194, 92, "sarvam-cli", "REPL + agent loop", t))
    p.append(box(404, 62, 210, 92, "sarvamai SDK", "sarvam-105b", t,
                 title_fill=t["accent"]))
    p.append(box(404, 250, 210, 74, "Approval gate", "[y/N]", t,
                 fill=t["gate_bg"], stroke=t["gate_stroke"], title_fill=t["gate"]))

    # tools panel
    p.append(f'<rect x="136" y="234" width="218" height="106" rx="8" '
             f'fill="{t["box"]}" stroke="{t["stroke"]}" stroke-width="1.5"/>')
    p.append(f'<text x="245" y="256" text-anchor="middle" font-family="{SANS}" '
             f'font-size="13" font-weight="600" fill="{t["fg"]}">Tools</text>')
    for i, tool in enumerate(["read_file", "write_file", "patch", "run_shell"]):
        col, row = i % 2, i // 2
        p.append(f'<text x="{152 + col * 104}" y="{280 + row * 22}" font-family="{MONO}" '
                 f'font-size="11.5" fill="{t["tool"]}">{esc(tool)}</text>')

    # ---- arrows ------------------------------------------------------------
    a = t["arrow"]
    A = f'stroke="{a}" stroke-width="1.6" fill="none" marker-end="url(#arw-{name})"'

    p.append(f'<path d="M120 108 L154 108" {A}/>')
    p.append(f'<path d="M356 96 L400 96" {A}/>')
    p.append(label(378, 86, "prompt", t))
    p.append(f'<path d="M400 128 L358 128" {A}/>')
    p.append(label(378, 146, "stream", t))

    # SDK -> approval gate
    p.append(f'<path d="M509 156 L509 246" {A}/>')
    p.append(label(519, 205, "tool_call", t, anchor="start"))

    # gate -> tools
    p.append(f'<path d="M400 287 L358 287" {A}/>')
    p.append(label(379, 277, "y", t, color=t["gate"]))

    # tools -> back into the loop
    p.append(f'<path d="M245 230 L245 158" {A}/>')
    p.append(label(235, 196, "result", t, anchor="end"))

    # denial path
    p.append(f'<path d="M614 287 L648 287 L648 108 L618 108" {A}/>')
    p.append(label(660, 200, "n → declined", t, anchor="start"))

    p.append(label(440, 366, "every side effect is gated — nothing touches disk unapproved",
                   t, size=12))

    body = "\n  ".join(p)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" \
viewBox="0 0 {W} {H}" role="img" aria-label="sarvam-cli agent loop: prompts stream to the \
Sarvam SDK, tool calls pass through an approval gate before any tool runs, and results feed \
back into the loop">
  <defs>
    <marker id="arw-{name}" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="{a}"/>
    </marker>
  </defs>
  {body}
</svg>
"""


def main():
    out = pathlib.Path(__file__).resolve().parent.parent / "docs"
    out.mkdir(exist_ok=True)
    for name, theme in THEMES.items():
        path = out / f"architecture-{name}.svg"
        path.write_text(build(name, theme), encoding="utf-8")
        print(f"wrote {path.relative_to(path.parent.parent)}  ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
