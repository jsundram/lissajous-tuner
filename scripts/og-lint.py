#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# ///
"""Catch an OG share card too big for link scrapers to render.

The og:image is the difference between a rich link preview and a grey box. When someone pastes the
URL, iMessage/WhatsApp/Slack fetch that image — and quietly SKIP one over ~300 KB. So a card that
rasterized fine but never got compressed previews as *nothing*, and you only find out when a friend
texts back a blank box. `make-og.sh` compresses + gates at generation time; this guards the commit,
catching a hand-exported or externally-produced PNG that never went through the script.

So: if this commit stages an oversized OG image, warn.

MAX_BYTES keeps a margin under WhatsApp's ~300 KB scrape cutoff (keep in sync with make-og.sh).

The pre-commit hook runs it warn-only; run it in CI with a real exit code. By hand:
    python3 scripts/og-lint.py
"""
import subprocess, sys

MAX_BYTES = 250_000   # keep in sync with scripts/make-og.sh


def sh(*a):
    return subprocess.run(a, capture_output=True, text=True)


def is_card(path):
    name = path.rsplit("/", 1)[-1]
    return name == "og.png" or (name.startswith("og-") and name.endswith(".png"))


def blob_size(path):                              # staged bytes, without reading the binary in
    r = sh("git", "cat-file", "-s", f":{path}")
    return int(r.stdout) if r.returncode == 0 and r.stdout.strip().isdigit() else None


def main():
    staged = sh("git", "diff", "--cached", "--name-only").stdout.split()
    over = []
    for f in staged:
        if not is_card(f):
            continue
        n = blob_size(f)
        if n is not None and n > MAX_BYTES:
            over.append((f, n))
    if not over:
        return 0
    print("  OG share card exceeds the scraper size budget (some previews will show a grey box):")
    for f, n in over:
        print(f"           {f}  {n:,} bytes  (> {MAX_BYTES:,})")
    print("  Recompress: rerun scripts/make-og.sh (pngquant), simplify og.svg, or shrink the palette.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
