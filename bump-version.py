#!/usr/bin/env python3
"""Bump the app version in one action.

Usage:
    python bump-version.py 2.0.1

Updates BOTH places the version has to appear and keeps them in sync:

  js/version.js   BUILD_VERSION / BUILD_DATE
                    -> the header stamp, and the ?v= on the Service
                       Worker registration URL (which is what makes the
                       browser install a new worker and drop old caches)

  index.html      the ?v= query on every <link>/<script>
                    -> invalidates the BROWSER's own HTTP cache.
                       GitHub Pages serves assets with max-age=600, so
                       without this a reload can still run 10-minute-old
                       code whenever the Service Worker is not active
                       (first visit, or dev mode).

Run this instead of hand-editing either file, then commit and push.
"""
import datetime
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
VERSION_JS = os.path.join(ROOT, 'js', 'version.js')
INDEX_HTML = os.path.join(ROOT, 'index.html')

VERSION_RE = re.compile(r"^(2|[0-9]+)\.[0-9]+\.[0-9]+(-[0-9A-Za-z.\-]+)?$")


def read(path):
    return io.open(path, encoding='utf-8').read()


def write(path, text):
    io.open(path, 'w', encoding='utf-8', newline='').write(text)


def current_version():
    m = re.search(r"const BUILD_VERSION = '([^']+)'", read(VERSION_JS))
    return m.group(1) if m else None


def bump(new_version):
    today = datetime.date.today().isoformat()

    # ── js/version.js ────────────────────────────────────────────
    src = read(VERSION_JS)
    src, n1 = re.subn(r"const BUILD_VERSION = '[^']*'",
                      "const BUILD_VERSION = '%s'" % new_version, src)
    src, n2 = re.subn(r"const BUILD_DATE    = '[^']*'",
                      "const BUILD_DATE    = '%s'" % today, src)
    if not (n1 and n2):
        sys.exit('ERROR: could not find BUILD_VERSION / BUILD_DATE in js/version.js')
    write(VERSION_JS, src)

    # ── index.html: stamp every local asset reference ────────────
    html = read(INDEX_HTML)

    def stamp(match):
        attr, path = match.group(1), match.group(2)
        base = path.split('?')[0]
        return '%s="%s?v=%s"' % (attr, base, new_version)

    # href="css/x.css" / src="js/x.js"  (local paths only)
    html, n3 = re.subn(r'(href|src)="((?:css|js)/[^"]+\.(?:css|js))(?:\?[^"]*)?"',
                       stamp, html)
    write(INDEX_HTML, html)

    print('BUILD_VERSION -> %s' % new_version)
    print('BUILD_DATE    -> %s' % today)
    print('index.html    -> %d asset references stamped' % n3)
    print('')
    print('Next: commit and push. One reload on the device is enough.')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('current version: %s' % current_version())
        print('usage: python bump-version.py <new-version>   e.g. 2.0.1')
        sys.exit(1)

    target = sys.argv[1].strip()
    if not VERSION_RE.match(target):
        sys.exit('ERROR: version must look like 2.0.1 or 2.0.1-hotfix')
    bump(target)
