#!/usr/bin/env python3
"""Install the MPFB asset packs the cast wears.

Usage:  fetch_assets.py [--force]

MPFB ships with the code but not the wardrobe: a fresh install can make a naked
body and nothing else. The garments, hair, eyes, eyebrows and skins come as
community "asset packs" — zips of .mhclo/.obj/.mhmat plus a packs/<name>.json
manifest carrying author, license and source URL per asset. licenses.py reads
those manifests, so installing a pack is also what makes the credits derivable
rather than hand-written.

Installing is exactly what MPFB's own "Load pack from zip" operator does:
extractall into the user data root. No GUI, no Blender needed for this step.

Every pack below is the _cc0 build. The community site also publishes CC-BY and
"all licenses" builds of the same packs; those are deliberately not used, because
one CC-BY garment would put an attribution requirement on the shipped game
binary for a shirt nobody looks at.
"""
import io
import json
import os
import sys
import urllib.request
import zipfile

# MPFB keeps user-installed assets and shipped system data in two different
# roots. This is the first — the one LocationService.get_user_data() returns,
# and the only one with a packs/ manifest directory.
DATA = os.path.expanduser(
    "~/Library/Application Support/Blender/4.5/extensions/.user/"
    "user_default/mpfb/data")

BASE = "https://files.makehumancommunity.org/asset_packs"

PACKS = {
    # Everything the base cast is built from: the hair, eyes, eyebrows and skins
    # that MakeHuman itself shipped, re-released as a pack for MPFB.
    "makehuman_system_assets": "eyes, eyebrows, hair, skins, casualsuits, worksuit, shoes",
    # The hunter's three garments, and the only community assets in the cast.
    "pants01": "cortu_cargo_pants",
    "shirts01": "toigo_fisherman_sweater",
    "shoes01": "toigo_ankle_boots_male",
}


def installed(name):
    return os.path.exists(os.path.join(DATA, "packs", name + ".json"))


def install(name, why, force):
    if installed(name) and not force:
        print(f"SKIP  {name:24s} already installed")
        return
    url = f"{BASE}/{name}/{name}_cc0.zip"
    with urllib.request.urlopen(url) as r:
        blob = r.read()
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        names = z.namelist()
        # The packs are trusted upstream, but extractall onto an absolute or
        # ../ path would write outside the data root, and this runs unattended.
        for n in names:
            if os.path.isabs(n) or ".." in n.split("/"):
                sys.exit(f"{name}: refusing entry outside the data root: {n}")
        z.extractall(DATA)
    print(f"OK    {name:24s} {len(blob) // 1024:6d} KiB, {len(names):3d} entries  ({why})")


def main():
    force = "--force" in sys.argv
    os.makedirs(os.path.join(DATA, "packs"), exist_ok=True)
    for name, why in PACKS.items():
        install(name, why, force)

    # A pack that downloads and extracts but lands its manifest somewhere
    # unexpected would leave licenses.py unable to credit anything in it, and
    # that failure is silent at build time and legally loud later.
    missing = [n for n in PACKS if not installed(n)]
    if missing:
        sys.exit(f"no manifest after install for: {', '.join(missing)}")
    total = sum(len(json.load(open(os.path.join(DATA, "packs", n + ".json"))))
                for n in PACKS)
    print(f"{len(PACKS)} packs, {total} assets catalogued in {DATA}/packs")


if __name__ == "__main__":
    main()
