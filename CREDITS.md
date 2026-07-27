# Credits

## Textures

The six PBR material sets in `public/assets/textures/` come from
[Poly Haven](https://polyhaven.com/textures) and are released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) — public domain,
no attribution required. It is listed here anyway because the people who make
these deserve the credit.

| Material | Used for | Source |
| --- | --- | --- |
| `aerial_grass_rock` | grassland terrain layer | https://polyhaven.com/a/aerial_grass_rock |
| `dry_ground_rocks` | dirt / trail terrain layer | https://polyhaven.com/a/dry_ground_rocks |
| `bark_brown_02` | tree trunks and branches | https://polyhaven.com/a/bark_brown_02 |
| `rock_wall_02` | boulders and the boundary cliffs | https://polyhaven.com/a/rock_wall_02 |
| `patterned_clay_wall` | hut walls | https://polyhaven.com/a/patterned_clay_wall |
| `reed_roof_04` | hut roofs | https://polyhaven.com/a/reed_roof_04 |

Each set ships as three WebP files — `_diff` (albedo), `_nor` (OpenGL-convention
tangent normal) and `_arm` (ambient occlusion in R, roughness in G, metalness in
B). They are downloaded and recompressed by `scripts/fetch-assets.sh`; the WebP
output is committed so a clean checkout needs no network access.

## Characters

The five people in `public/models/` are built from
[MakeHuman](http://www.makehumancommunity.org/) body, skin and clothing assets
by `tools/characters/build.sh`, which drives
[MPFB2](https://static.makehumancommunity.org/mpfb.html) inside headless
Blender. Every asset below is [CC0
1.0](https://creativecommons.org/publicdomain/zero/1.0/). The list is not
maintained by hand — `tools/characters/licenses.py` reads
`tools/characters/cast.json`, looks each asset up in the MPFB asset-pack
manifests, and fails the build if anything has no recorded license, so a shirt
swapped without a credit cannot ship.

| Asset | Author | Source |
| --- | --- | --- |
| `low-poly` (eyes) | makehuman_system | http://www.makehumancommunity.org |
| `eyebrow007`, `eyebrow010` | makehuman_system | http://www.makehumancommunity.org |
| `short01`, `short02`, `ponytail01` (hair) | makehuman_system | http://www.makehumancommunity.org |
| `middleage_caucasian_male` (skin) | makehuman_system | http://www.makehumancommunity.org |
| `middleage_asian_male` (skin) | makehuman_system | http://www.makehumancommunity.org |
| `young_caucasian_male` (skin) | makehuman_system | http://www.makehumancommunity.org |
| `old_asian_male` (skin) | makehuman_system | http://www.makehumancommunity.org |
| `young_african_female` (skin) | makehuman_system | http://www.makehumancommunity.org |
| `male_casualsuit01`, `male_casualsuit05` | makehuman_system | http://www.makehumancommunity.org |
| `female_casualsuit01` | makehuman_system | http://www.makehumancommunity.org |
| `shoes01`, `shoes02`, `shoes03`, `shoes05` | makehuman_system | http://www.makehumancommunity.org |
| `namuhekam_male_polo_shirt` | namuhekam | http://www.makehumancommunity.org/node/2909 |
| `elvs_crude_t-shirt_male` | Elvaerwyn | http://www.makehumancommunity.org/node/1416 |
| `cortu_cargo_pants` | Cortu | http://www.makehumancommunity.org/node/2798 |
| `toigo_wool_pants` | MargaretToigo | http://www.makehumancommunity.org/node/1194 |
| `toigo_ankle_boots_male` | MargaretToigo | http://www.makehumancommunity.org/node/1743 |

MakeHuman ships the MakeHuman logo silkscreened onto the back of
`female_casualsuit01`. It is CC0 and legal to ship, and it still reads as
somebody else's branding on a villager, so `tools/characters/pack.py` copies a
clean square of the same fabric over it.

## Animation

The nine clips in `public/models/anims.glb` come from the **CMU Graphics Lab
Motion Capture Database** (http://mocap.cs.cmu.edu/), which is free for all use
and asks only that the database be acknowledged. The BVH conversion of that
database is by **B. Hahne** ("cgspeed"). The database's own request:

> The data used in this project was obtained from mocap.cs.cmu.edu. That
> database was created with funding from NSF EIA-0196217.

| Clip | CMU take |
| --- | --- |
| `idle` | 141_20 Waiting |
| `idle2` | 141_13 Stretch and Yawn |
| `walk` | 141_19 Walk |
| `run` | 143_42 Run |
| `sneak` | 143_41 Sneak |
| `chores` | 143_28 Sweeping, Push Broom |
| `wounded` | 139_19 |
| `flee` | 142_16 Scared |
| `collapse` | 140_01 Get Up Face Down, played backwards |

`tools/characters/fetch_bvh.sh` downloads the conversion and
`tools/characters/anim.py` retargets it onto the MPFB `cmu_mb` rig, so nothing
motion-captured is committed to this repository.

## Everything else

Every other asset is generated in code at load time and has no third-party
source: tiger fur, cloth, blood decals, grass blades, leaf cards and particle
sprites are drawn into 2D canvases (`src/world/textures.ts`), the sky is a
Preetham analytic model (`src/render/sky.ts`), all geometry is built as
`BufferGeometry` in code, and all audio is synthesised with WebAudio
oscillators and noise buffers — sound effects and the reverb impulse responses
in `src/engine/audio.ts`, the adaptive score in `src/engine/music.ts`. There are
no audio files, so there is nothing to license and nothing to fail to load.

## Libraries

- [Three.js](https://threejs.org/) — MIT
- [Vite](https://vitejs.dev/) — MIT
- [TypeScript](https://www.typescriptlang.org/) — Apache-2.0
