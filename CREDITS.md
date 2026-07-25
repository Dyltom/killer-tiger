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

## Everything else

All other assets are generated in code at load time and have no third-party
source: tiger fur, cloth, blood decals, grass blades, leaf cards and particle
sprites are drawn into 2D canvases (`src/world/textures.ts`), the sky is a
Preetham analytic model (`src/render/sky.ts`), all geometry is built as
`BufferGeometry` in code, and all audio is synthesised with WebAudio
oscillators and noise buffers (`src/engine/audio.ts`).

## Libraries

- [Three.js](https://threejs.org/) — MIT
- [Vite](https://vitejs.dev/) — MIT
- [TypeScript](https://www.typescriptlang.org/) — Apache-2.0
