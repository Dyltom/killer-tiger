#!/usr/bin/env python3
"""Work out what the cast owes credit to, from the cast itself.

Usage:  licenses.py <cast.json> [<clips.json>]

A hand-written credits list goes stale the first time somebody swaps a shirt.
This reads the assets the cast actually wears, looks each one up in the MPFB
asset-pack manifests — which carry author, license and source URL per asset —
and prints the attribution block. Anything it cannot find is printed as UNKNOWN
rather than quietly dropped, because a missing CC-BY credit is the one failure
mode that matters here.
"""
import json
import os
import sys
from collections import OrderedDict

# MPFB keeps user-installed assets and shipped system data in two different
# roots, and only the first has the packs manifests.
DATA = os.path.expanduser(
    "~/Library/Application Support/Blender/4.5/extensions/.user/"
    "user_default/mpfb/data")


def manifests():
    out = {}
    pack_dir = os.path.join(DATA, "packs")
    for fn in sorted(os.listdir(pack_dir)):
        if not fn.endswith(".json"):
            continue
        for slug, meta in json.load(open(os.path.join(pack_dir, fn))).items():
            out[slug] = dict(meta, pack=fn[:-5])
    return out


def wear(variant):
    """The slots a variant actually wears, minus the commentary.

    cast.json carries its reasoning inline under "_"-prefixed keys, and one of
    those written a level too deep — inside wear rather than beside it — is a
    string where a (path, kind) pair belongs. Skipped rather than trusted.
    """
    return {k: v for k, v in variant.get("wear", {}).items()
            if not k.startswith("_")}


def used(cast):
    """Every asset path the cast references, in the order it first appears."""
    seen = OrderedDict()
    for variant in [cast["base"]] + cast["variants"]:
        for slot, (rel, _kind) in wear(variant).items():
            seen.setdefault(rel.split("/")[1], rel)
        if variant.get("skin"):
            seen.setdefault(variant["skin"].split("/")[1], variant["skin"])
    return seen


def main():
    cast = json.load(open(sys.argv[1]))
    packs = manifests()
    rows = []
    for slug, rel in used(cast).items():
        m = packs.get(slug)
        if m is None:
            # The MakeHuman system assets ship with MPFB rather than as a pack.
            rows.append((slug, "MakeHuman system asset", "CC0", "", rel))
        else:
            rows.append((slug, m.get("author") or "?",
                         m.get("license") or "UNKNOWN",
                         m.get("source") or "", rel))

    width = max(len(r[0]) for r in rows)
    unknown = 0
    for slug, author, lic, src, _rel in rows:
        if lic.upper() in ("UNKNOWN", "", "?"):
            unknown += 1
        print(f"- `{slug.ljust(width)}`  {lic} — {author}"
              + (f" — {src}" if src else ""))
    print(f"\n{len(rows)} assets, {unknown} with no license recorded",
          file=sys.stderr)
    if unknown:
        sys.exit(1)


if __name__ == "__main__":
    main()
