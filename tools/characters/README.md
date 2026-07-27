# Characters

Everything that produces the five humans in `public/models/`, plus the animation
library they share. Nothing in here runs at game time — the game loads six `.glb`
files and never knows this existed.

```sh
npm install --prefix tools/characters   # once: the gltf-transform CLI
tools/characters/build.sh               # ~40s, writes public/models/
tools/characters/build.sh villager_a    # ~14s, one character (anims rebuild anyway)
```

`BLENDER=` overrides the Blender path, `OUT=` the scratch directory. Blender
4.5 LTS with the MPFB2 extension installed is the only prerequisite the script
cannot install for itself.

## Where the people come from

MPFB2 — the MakeHuman Plugin for Blender. GPL-3 code, **CC0 assets**, and it
drives fine headlessly, which is the whole reason it beat the alternatives: no
GUI step, no account, no licence that follows the shipped build. `fetch_assets.py`
pulls the four asset packs the cast wears, and every one is the `_cc0` build
rather than the "all licences" build, so nothing puts an attribution requirement
on the game binary. `licenses.py` reads the packs' own manifests and prints the
credits, which is why `CREDITS.md` is derived rather than typed.

`cast.json` is the whole cast: a `base` (macro sliders, skin, eyes, brows, hair,
material look) and five `variants` that override it. Adding a sixth villager is
one more entry. Any key beginning with `_` is commentary and is skipped by both
`gen.py` and `licenses.py`, so the reason for a choice can live next to it.

Three things in `gen.py` are load-bearing and will look like over-engineering
until they are removed:

- **Materials are rebuilt, not edited.** MPFB authors a node graph for offline
  rendering. The glTF exporter can only express `baseColorTexture × baseColorFactor`,
  so everything past the first mix is silently dropped and the character arrives
  looking washed out or invisible. Each slot gets a fresh two-node Principled
  graph instead.
- **Tints are baked into pixels**, for the same reason: a multiply node does not
  survive the export.
- **`detailed_helpers=True` is mandatory.** It creates the 125 `joint-*` vertex
  groups the rig fits its bones to. Without them the skeleton lands about 0.9 m
  below the mesh, and — because everything is authored in bind pose — nothing
  looks wrong until the first rotated frame. `rigfix.check()` is the guard.

The rig is added **before** the garments. `add_mhclo_asset` only skins a garment
if a skeleton already exists among the basemesh's relatives; get the order wrong
and the clothes stay rigid while the body moves inside them.

## Choosing a garment

Every MPFB asset ships a `.thumb` next to its `.mhclo` — a PNG of the garment on
a mannequin. It is a renamed PNG, so `cp foo.thumb foo.png` and look. That is the
fastest way to shortlist a wardrobe by an order of magnitude, and it is the step
that gets skipped in favour of reading diffuse maps, which tells you a colour and
nothing about a cut.

Five things a thumbnail will not tell you, all of which cost a rebuild each:

- **A garment fitted to MakeHuman's default body may not survive this one.** MPFB
  maps garment vertices onto the body through the helper mesh, and the fit can
  collapse a sleeve's cross-section to nearly zero radius —
  `toigo_fisherman_sweater` ships as a long-sleeved knit and arrives as a vest
  with a knot at each elbow. Nothing downstream can put the width back. The
  giveaway is a render in the **skeleton's rest pose**
  (`mesh.skeleton.pose()`), where a good sleeve is a tube and a broken one is a
  cone tapering to a point.
- **Hair drawn as opaque panels hangs over the eyes.** `bob01`, `bob02` and
  `short03` are a few large fully-opaque sweeps; fitted to a head they were not
  authored for, the fringe reaches the mouth and the villager has no face.
  Raising the alpha cutoff cannot help, because there is no alpha there to cut.
  `short01`, `short02` and `ponytail01` are layered strands with real alpha edges
  and survive any head — and are thousands of triangles cheaper.
- **A one-pixel stripe becomes a neon line.** `male_casualsuit03` is a maroon
  pinstripe shirt whose white stripe is one pixel wide in a 4096 map; the resize
  to 1024 leaves it as full-brightness lines that ACES then pushes to magenta.
  Flat garments cannot alias.
- **`recolour`, not `tint`, for anything authored near black or near white.**
  `tint` multiplies, so a dark hair card times a dark brown is black. `recolour`
  sets an alpha-weighted mean level and keeps the detail. It sets a *linear
  albedo*, and this game's sun plus ACES lifts a mid value most of a stop: 0.26
  aimed at olive drab renders as pale sage, 0.13 is olive drab.
- **`inflate` puffs a short sleeve into a leg of mutton.** It pushes every vertex
  along its own normal, and on a sleeve cap the normals fan out in every
  direction at once. What a bust needs (0.013) is twice what a cap can take.

## Where the motion comes from

CMU Graphics Lab Motion Capture Database, free for all use including commercial,
via B. Hahne's BVH conversion. `fetch_bvh.sh` downloads the nine takes
`clips.json` names — not committed, since they are 5 MB of immutable ASCII for a
build that runs twice a year.

`retarget.py` is the interesting part. MPFB's `cmu_mb` rig uses the CMU *bone
names* but not the CMU *rest pose* — they disagree by 21° at the median joint and
166° at the neck, so copying local rotations across gives a person folded inside
out. Instead each bone's motion is taken as its deviation from its own rest pose,
in world space, and replayed as the same deviation from the target's rest pose.

Three corrections sit on top of that, each of which was a visible bug first:

- **`facing()`** removes the take's baked-in compass bearing. Each performer
  walked off in whatever direction the capture volume allowed, and that bearing
  rides in the hips — left alone, a villager spins on the spot the moment the
  game crossfades from idle to walk.
- **Absolute hip height, not drift.** Keying the hips' *drift* from frame one
  holds the pelvis at rest height, so a crouching clip lifts its feet off the
  floor instead of lowering its hips. Every idle hovered.
- **`ground()`** then shifts the whole clip once, by the error between its lowest
  footfall and the rest pose's floor — once per clip, never per frame, or the bob
  flattens and the feet glue to the ground through a run.

`clips.json` picks nine clips, and each `_src` records *why that take*. Names
lie: CMU 140_06 is called "Idle" and is a performer settling into a 25–31° hunch
two seconds in and staying there for the remaining twenty-eight. `scan.py` is
what catches that — it reports lean, hip height and motion per second across a
take, so a window gets chosen by measurement instead of by eye.

One skeleton, no mesh, 31 bones, nine clips, 260 KiB. three.js binds tracks to
bones by name and all five characters carry the same names, so `anims.glb` drives
the entire cast.

## Sizing

`pack.py` resizes and re-encodes textures by role; `optimise.sh` runs
`gltf-transform optimize` with simplification and meshopt. Together: 8.5 MB → 2.2 MB,
and `villager_a` from 38,774 to 16,809 triangles with no visible difference.

The frame is fill-bound at ~2.9 ms/megapixel, so none of this buys frame time —
it buys download and VRAM. Don't reach for more aggressive simplification hoping
for FPS.

Loading the result needs the meshopt decoder:

```ts
loader.setMeshoptDecoder(MeshoptDecoder)   // three/examples/jsm/libs/meshopt_decoder.module.js
```

## Checking the result

Bind pose hides every skinning and rig error, so a still of the rest pose proves
nothing. `leancheck.py` measures torso lean on the source and on the retargeted
rig at the same frame, which answers "is the hunch ours or the actor's" in one
number per clip. `gltfcheck.py` reads the exported buffers directly — joint
indices, weight sums, accessor counts.

`portrait.sh` is the review harness — a portrait of one cast member, in the
running game, in the game's own light:

```sh
tools/characters/portrait.sh <surface> <mesh-substring> <name> [head|body] [hide-re] [model]
tools/characters/portrait.sh surface:238 short01 a head
tools/characters/portrait.sh surface:238 x elder body '(?!)' villager_elder
```

It writes `/tmp/kt/<name>.png` via the shot daemon. Two of its arguments exist
because of specific dead ends:

- **`model`** re-dresses a villager who is already standing there. Each pool slot
  in `Human` draws its body once in the constructor and keeps it for the run, so
  with ten villagers alive and four bodies to draw from, one of the five is
  usually nowhere on the map — and a character you cannot photograph is a
  character that ships unlooked-at. (`Human.attach()` is private to TypeScript
  and ordinary to the runtime.)
- **`hide-re`** hides the meshes that match it, which is how you find out which
  mesh owns a defect. The elder's dark crotch smudge turned out to be the polo's
  authored split hem showing shadowed trousers through it, and one shot with the
  trousers hidden said so.

Note that facing lives on `h.group.rotation.y`, not on `h.avatar.root` — the
avatar's own root carries the glTF's `rotation.y = π` and turning it turns the
model inside its own frame. And `idle2` is CMU's "Stretch and Yawn": the
arms-out, palms-forward pose it is often caught in is one phase of that stretch,
not a rig failure.

For anything visual, use the review harness rather than Blender's viewport: this
game's look is almost entirely post-shading (Preetham sky as IBL, one hard sun,
ACES, bloom, grade), so a character judged in the viewport is a character judged
under the wrong lighting. Albedo that survives that chain: cloth 0.05–0.26 linear,
skin ~0.30; anything near 0.65 clips to white.
