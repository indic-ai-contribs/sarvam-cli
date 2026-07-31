#!/usr/bin/env python3
"""Record docs/demo.gif by driving the real `sarvam` binary over a pty.

No vhs/asciinema/ttyd needed. Drives the actual CLI, captures its output with
timestamps, replays it through a small terminal emulator, and renders frames
with Pillow. Frames are emitted only when the screen changes, with per-frame
delays, which keeps the GIF small.

Requires: Pillow, a monospace TTF/OTF, and a working `sarvam` on PATH with a
configured API key (scene 3 makes one real model call).

Usage:  python3 scripts/record-demo.py [--out docs/demo.gif] [--no-agent]
"""
import argparse, fcntl, os, pathlib, pty, re, select, shutil, struct
import subprocess, sys, termios, time

COLS, ROWS = 96, 22
FONT_CANDIDATES = [
    "/usr/share/fonts/jetbrains-mono-fonts/JetBrainsMono-Regular.otf",
    "/usr/share/fonts/google-droid-sans-mono-fonts/DroidSansMono.ttf",
    "/usr/share/fonts/dejavu-sans-mono-fonts/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
]
BOLD_CANDIDATES = [
    "/usr/share/fonts/jetbrains-mono-fonts/JetBrainsMono-Bold.otf",
    "/usr/share/fonts/dejavu-sans-mono-fonts/DejaVuSansMono-Bold.ttf",
]

BG = (13, 17, 23)
FG = (230, 237, 243)
PALETTE = {  # SGR code -> rgb
    31: (255, 123, 114), 32: (63, 185, 80), 33: (210, 153, 34),
    34: (88, 166, 255), 35: (188, 140, 255), 36: (57, 197, 187),
    37: FG, 90: (110, 118, 129),
}
DIM = (125, 133, 144)

PAD, LINE_H, CHAR_W, FONT_SIZE = 18, 22, 9, 15


# --------------------------------------------------------------------------
# terminal emulator: just enough for what the REPL emits
# --------------------------------------------------------------------------
class Screen:
    def __init__(self, cols, rows):
        self.cols, self.rows = cols, rows
        self.buf = [[(" ", FG, False) for _ in range(cols)] for _ in range(rows)]
        self.x = self.y = 0
        self.fg, self.dim, self.bold = FG, False, False

    def _scroll(self):
        self.buf.pop(0)
        self.buf.append([(" ", FG, False) for _ in range(self.cols)])
        self.y = self.rows - 1

    def _put(self, ch):
        if self.x >= self.cols:
            self.x = 0
            self.y += 1
        if self.y >= self.rows:
            self._scroll()
        color = DIM if self.dim else self.fg
        self.buf[self.y][self.x] = (ch, color, self.bold)
        self.x += 1

    def sgr(self, params):
        for p in params or [0]:
            if p == 0:
                self.fg, self.dim, self.bold = FG, False, False
            elif p == 1:
                self.bold = True
            elif p == 2:
                self.dim = True
            elif p == 3:
                pass  # italic — rendered as normal
            elif p in PALETTE:
                self.fg = PALETTE[p]

    def feed(self, data):
        i = 0
        while i < len(data):
            c = data[i]
            if c == "\x1b" and i + 1 < len(data) and data[i + 1] == "[":
                m = re.match(r"\x1b\[([0-9;]*)([A-Za-z])", data[i:])
                if not m:
                    i += 1
                    continue
                raw, cmd = m.group(1), m.group(2)
                params = [int(x) if x else 0 for x in raw.split(";")] if raw else []
                if cmd == "m":
                    self.sgr(params)
                elif cmd == "G":
                    self.x = max(0, (params[0] if params else 1) - 1)
                elif cmd == "J" and (not params or params[0] == 0):
                    for xx in range(self.x, self.cols):
                        self.buf[self.y][xx] = (" ", FG, False)
                    for yy in range(self.y + 1, self.rows):
                        self.buf[yy] = [(" ", FG, False) for _ in range(self.cols)]
                elif cmd == "K":
                    rng = range(self.cols) if params and params[0] == 2 else range(self.x, self.cols)
                    for xx in rng:
                        self.buf[self.y][xx] = (" ", FG, False)
                elif cmd == "C":
                    self.x = min(self.cols - 1, self.x + max(1, params[0] if params else 1))
                elif cmd == "D":
                    self.x = max(0, self.x - max(1, params[0] if params else 1))
                i += m.end()
                continue
            if c == "\n":
                self.y += 1
                if self.y >= self.rows:
                    self._scroll()
            elif c == "\r":
                self.x = 0
            elif c == "\t":
                self.x = min(self.cols - 1, (self.x // 8 + 1) * 8)
            elif c == "\x07":
                pass
            elif c >= " ":
                self._put(c)
            i += 1

    def snapshot(self):
        return tuple(tuple(row) for row in self.buf)


# --------------------------------------------------------------------------
# capture
# --------------------------------------------------------------------------
def type_out(fd, text, cps=28):
    """Write text one char at a time so the recording looks hand-typed."""
    for ch in text:
        os.write(fd, ch.encode())
        time.sleep(1.0 / cps)


def capture(steps, cwd, env_extra=None):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    env = dict(os.environ, TERM="xterm-256color", COLUMNS=str(COLS), LINES=str(ROWS),
               **(env_extra or {}))
    p = subprocess.Popen(["sarvam"], stdin=slave, stdout=slave, stderr=slave,
                         cwd=cwd, env=env, close_fds=True)
    os.close(slave)

    events, t0 = [], time.time()

    def drain(seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([master], [], [], 0.02)
            if r:
                try:
                    d = os.read(master, 8192)
                except OSError:
                    return False
                if not d:
                    return False
                events.append((time.time() - t0, d.decode("utf-8", "replace")))
        return True

    def seen():
        return "".join(c for _, c in events)

    drain(1.4)
    mark = 0  # offset of the most recent input we sent
    for kind, payload, wait in steps:
        if p.poll() is not None:
            break
        if kind == "expect":
            # Wait for the CLI to actually reach a state (e.g. the approval
            # prompt) instead of guessing with a fixed delay. Firing `y` on a
            # timer races the model and lands as a stray prompt if it's early.
            # Search from the last input we sent, not from now — the thing we're
            # waiting for may already have arrived during the preceding wait.
            deadline = time.time() + wait
            while time.time() < deadline:
                if re.search(payload, seen()[mark:]):
                    break
                if not drain(0.1):
                    break
            else:
                print(f"  ! timed out waiting for {payload!r}", file=sys.stderr)
            continue
        mark = len(seen())
        if kind == "type":
            for ch in payload:
                os.write(master, ch.encode())
                time.sleep(0.036)
                drain(0.004)
        else:
            os.write(master, payload.encode())
        if not drain(wait):
            break
    if p.poll() is None:
        drain(1.0)
        p.kill()
        p.wait()
    return events


# --------------------------------------------------------------------------
# render
# --------------------------------------------------------------------------
def pick(paths):
    for p in paths:
        if os.path.exists(p):
            return p
    return None


def render(events, out_path, max_hold=1.6, min_delay=0.05):
    from PIL import Image, ImageDraw, ImageFont

    reg_path = pick(FONT_CANDIDATES)
    if not reg_path:
        sys.exit("No monospace font found — edit FONT_CANDIDATES.")
    bold_path = pick(BOLD_CANDIDATES) or reg_path
    font = ImageFont.truetype(reg_path, FONT_SIZE)
    font_b = ImageFont.truetype(bold_path, FONT_SIZE)

    # Pass 1: replay everything to collect the snapshots we'll actually draw,
    # so the canvas can be cropped to the rows the demo really uses instead of
    # baking in a screenful of empty space.
    scr = Screen(COLS, ROWS)
    snaps, times, last_snap = [], [], None
    for t, chunk in events:
        scr.feed(chunk)
        snap = scr.snapshot()
        if snap != last_snap:
            snaps.append(snap)
            times.append(t)
            last_snap = snap
    if not snaps:
        sys.exit("Nothing captured.")

    used = 0
    for snap in snaps:
        for y in range(ROWS - 1, -1, -1):
            if any(ch != " " for ch, _, _ in snap[y]):
                used = max(used, y + 1)
                break
    used = max(used, 4)

    W = PAD * 2 + COLS * CHAR_W
    H = PAD * 2 + used * LINE_H + 26  # extra room for the title bar

    frames, delays, last_t = [], [], times[0]

    def draw_frame(snap):
        img = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, W, 26], fill=(22, 27, 34))
        for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
            d.ellipse([14 + i * 18, 9, 22 + i * 18, 17], fill=c)
        d.text((W // 2 - 34, 6), "sarvam-cli", font=font, fill=(139, 148, 158))
        for y, row in enumerate(snap[:used]):
            for x, (ch, color, bold) in enumerate(row):
                if ch != " ":
                    d.text((PAD + x * CHAR_W, 26 + PAD + y * LINE_H), ch,
                           font=font_b if bold else font, fill=color)
        return img

    for snap, t in zip(snaps, times):
        if frames:
            delays.append(min(max(t - last_t, min_delay), max_hold))
        frames.append(draw_frame(snap))
        last_t = t

    delays.append(2.4)  # hold the final frame

    pal = [f.convert("P", palette=Image.ADAPTIVE, colors=64) for f in frames]
    pal[0].save(out_path, save_all=True, append_images=pal[1:],
                duration=[int(d * 1000) for d in delays], loop=0, optimize=True, disposal=2)
    return len(frames), os.path.getsize(out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="docs/demo.gif")
    ap.add_argument("--no-agent", action="store_true",
                    help="skip the real model call (no API usage, shorter demo)")
    args = ap.parse_args()

    demo = pathlib.Path("/tmp/sarvam-demo")
    if demo.exists():
        shutil.rmtree(demo)
    demo.mkdir(parents=True)
    (demo / "greet.py").write_text(
        'def greet(name):\n    return f"Namaste, {name}!"\n\n\n'
        'if __name__ == "__main__":\n    print(greet("Hyderabad"))\n'
    )
    (demo / "README.md").write_text("# demo\n")

    steps = [
        ("type", "! ls\r", 1.7),
        ("type", "! python3 greet.py\r", 2.0),
    ]
    if not args.no_agent:
        steps += [
            # Phrased to force run_shell, which is approval-gated — read_file
            # isn't, and a demo that never shows the [y/N] gate misses the point.
            ("type", "run greet.py and tell me what it prints\r", 3.0),
            ("expect", r"\[y/N\]", 25.0),
            ("raw", "y\r", 14.0),
        ]
    steps += [
        ("raw", "\x0f", 1.3),          # Ctrl+O — reasoning on
        ("raw", "\x0f", 1.3),          # Ctrl+O — reasoning off
        ("type", "/model\r", 2.0),
        ("type", "exit\r", 1.4),
    ]

    print(f"recording in {demo} …")
    events = capture(steps, cwd=str(demo))
    out = pathlib.Path(args.out)
    out.parent.mkdir(exist_ok=True)
    n, size = render(events, str(out))
    print(f"wrote {out} — {n} frames, {size/1024:.0f} KB")


if __name__ == "__main__":
    main()
