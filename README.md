# Killer Tiger

A first-person stalk-and-kill arcade game. You are a tiger. The village is prey.

Stalk through long grass, take villagers down before they scream, and survive the
hunters who come looking for you. Chain kills to multiply your score, hoard rage
until you can go into a blood frenzy, and clear as many hunts as you can.

## Run it

```bash
npm install
npm run dev        # http://localhost:5180
npm run build      # static files in dist/
npm run preview    # serve the production build
npm run typecheck
```

Nothing is fetched at run time and there is no build-time asset pipeline: the six
CC0 texture sets in `public/assets/textures/` are committed, and everything else
is generated in code. See [Assets](#assets).

## Controls

| Input | Action |
| --- | --- |
| `W A S D` | Move |
| Mouse | Look |
| `Shift` | Sprint (drains stamina, very loud) |
| `Ctrl` / `C` | Crouch — slow, quiet, and near-invisible in tall grass |
| `Space` | Pounce — a long forward leap; landing on someone tackles them |
| Left click | Claw swipe — fast, cleaves through everyone in the arc |
| Right click | Killing bite — short range, huge damage, heals you |
| `R` | Roar — panics everything nearby and staggers them |
| `Q` | Blood frenzy — spend a full rage bar for double damage and speed |
| `F` | Frame-rate readout (on by default) |
| `Esc` | Pause · `M` mute |

Add `?nolock` to the URL to play without pointer lock (mouse-look is disabled).
It exists so automated checks can drive the game inside embedded webviews.

## How it plays

**Stealth matters.** Humans detect you two ways. They *hear* you — sprinting
carries about five times further than crouching — and they *see* you, gated by
range, field of view, line of sight, and your own visibility. Crouching in tall
grass cuts your visible profile to roughly a third. Bite a villager from behind
while they're still unaware and it's an instant, silent execution.

**Noise cascades.** Once a human is certain of you they shout, and everyone
inside the shout radius is alerted. Villagers scatter toward campfires; hunters
close to their firing stand-off, shoulder a rifle, and shoot.

**The huts are real rooms.** Every hut in the village is a hollow shell with a
doorway you can walk through, and about six villagers in ten will run for one
rather than for the firelight. They pick a door away from you, cross the floor,
and press into the dark at the back facing the only way in — where you cannot see
them and they cannot see you, because line of sight goes through the doorway and
nothing else. Follow them in and they break and bolt past you; catch one between
the walls and the kill is worth half again as much.

**Chain kills.** Each kill inside the combo window raises your multiplier, up to
5×. Break the chain and it resets. This is where the score actually comes from.

**Rage and frenzy.** Kills fill the rage bar. A full bar buys a blood frenzy:
2.2× damage, 1.32× speed, reduced damage taken, and a widened FOV for the
duration.

**Pickups.** Six kinds spawn around the map and expire if ignored — meat (heal),
adrenaline (speed), iron claws (damage), iron hide (damage resistance), a relic
(pure score), and a rage idol (instant rage).

**Hunts.** Each hunt asks for a prey quota. Clear it and the next hunt brings more
villagers, more hunters, and tougher stats. It ends when you die.

## Assets

The only files in the repository are six CC0 PBR texture sets from Poly Haven —
albedo, normal and packed AO/roughness/metalness for grass, dirt, bark, rock,
clay and thatch. They are what the surfaces you spend the whole game looking at
are made of, and no amount of canvas drawing gets close to photographed material
data. They live in `public/assets/textures/` as WebP, are re-fetchable with
`scripts/fetch-assets.sh`, and are credited in [CREDITS.md](CREDITS.md).

Everything else is synthesised in code on first load:

- **Textures** — drawn into 2D canvases (tiger fur, cloth, blood, grass blades,
  leaf cards, particle sprites) with a value-noise grain pass, then uploaded as
  `CanvasTexture`.
- **Geometry** — low-poly `BufferGeometry` built in code. Trees, rocks, grass and
  the boundary cliffs are `InstancedMesh`.
- **Terrain** — a height field from deterministic fBm noise. `terrainHeight(x, z)`
  is a pure function that every system (tiger, humans, props, particles) shares,
  so nothing ever disagrees about where the ground is.
- **Sky and lighting** — a Preetham analytic sky, rendered once to an equirect and
  run through `PMREMGenerator` so the same sky that is drawn behind the world is
  also the image-based light on everything in it.
- **Audio** — WebAudio oscillators and shaped noise buffers. Roars, gunshots,
  screams and ambience are all synthesised per call, placed by an inverse-square
  distance model with air absorption, speed-of-sound arrival delay, and sends
  into two convolution reverbs built from synthetic impulse responses — a close
  treeline and a valley that answers about three seconds later. The whole mix
  runs through a glue compressor and a soft clipper whose linear region is wide
  enough that only the apex sounds ever reach it.
- **Score** — one evolving piece rather than a playlist. A lookahead scheduler
  runs a single bar clock for the session and fades nine layers in against the
  hunt number and how much trouble the player is in: hunt 1 is a drone and a
  heartbeat, hunt 8 under three rifles is drums, ostinato, brass and a
  dissonant string cluster, sixty beats a minute faster and a mode darker.
- **Particles** — one pooled `Points` system with a custom shader for blood, gore,
  dust, sparks and muzzle flash.

The result still runs offline from a static directory, loads in one round trip,
and stays tunable from `src/config.ts`.

## Layout

```
src/
├── config.ts            every tunable number in the game
├── main.ts              renderer, loop, overlay routing
├── game.ts              simulation: waves, combat, scoring, pickups, buffs
├── engine/              input, procedural audio, adaptive score, seeded RNG + noise
├── entities/            tiger, human, pickup, particles
├── render/              sky, image-based lighting, atmosphere, post-processing
├── world/               terrain, village, flora, wind, materials, textures
└── ui/                  HUD (the only module that touches the DOM)
```

Two rules keep this navigable: no gameplay magic numbers outside `config.ts`, and
no DOM access outside `ui/hud.ts`.

## Extending it

The systems were built with obvious seams to pull on:

- **New prey type** — `HUMAN` in `config.ts` is a table keyed by kind. Add an
  entry and a branch in `Human.updateBrain`. The rig, animation, perception and
  death handling are already shared.
- **New pickup** — add an entry to `PICKUP_TYPES` in `entities/pickup.ts` with a
  model builder, then handle its id in `Game.collect`. Timed buffs just need a
  `BUFFS` entry.
- **New building** — `roundHut` and `squareHut` in `world/village.ts` return a
  `HutBuild`; the collider gets a `hollow` descriptor and the AI gets three
  waypoints. The one convention to keep is that a door faces hut-local `+z`, so
  its world bearing is `(sin rot, cos rot)` and nothing downstream needs a second
  angle. Note that the collider frame is the transpose of three's, so yaws handed
  to `world.resolve` are negated.
- **New ability** — follow the roar: a cooldown on `Tiger`, a key check in
  `Game.updateActions`, and an effect loop over `humans`.
- **Day/night** — `SKY.sunElevation` and `SKY.sunAzimuth` in `config.ts` drive the
  Preetham sky, the sun direction, the IBL environment and the aerial-perspective
  fog together, so moving the sun moves the whole lighting model at once.
- **Bosses, objectives, weather** — `WAVE` drives all pacing; hook a special
  spawn into `Game.advanceWave`.

## Tech

TypeScript, Vite, and Three.js. Three.js was chosen over a full engine because it
gives direct control of the render loop with no editor and no project format,
which is what lets the renderer be assembled by hand:

- **Physically-based shading** on every surface, lit by a Preetham analytic sky
  prefiltered through `PMREMGenerator` into an IBL environment — so ambient light
  is the actual colour of the sky above each surface, not a flat hemisphere term.
- **A single 4096px directional shadow map** with PCF soft filtering, its frustum
  pulled in tight around the play area rather than the whole world, which buys the
  resolution that cascades would otherwise be needed for.
- **Aerial perspective** injected into every material with `onBeforeCompile`:
  distant geometry picks up sun-tinted inscatter instead of fading to one fog
  colour, which is what keeps the cliffs reading as distant rather than washed out.
- **Foliage translucency** — a back-lit SSS lobe on grass and leaves so a blade
  between you and the sun glows instead of going black.
- **Post chain** — radial god rays anchored to the sun's projected screen position,
  UnrealBloom, an ACES filmic tonemap, a colour grade, and SMAA.
- **Vertex wind** — one shared time uniform animating grass, leaves and banners in
  the vertex shader, so nothing costs a CPU update.

## Debug handle

In development, `window.__kt` exposes `game`, `world`, `camera`, `scene`, and:

- `step(frames, dt)` — advance the real loop at a fixed timestep
- `hold(code)` / `release(code)` — synthesise key input
- `click(button)` — synthesise a mouse click
- `look(dx, dy)` — feed mouse-look deltas
- `terrainHeight(x, z)` — the shared height field, for probing placement

`scripts/cam.sh` screenshots from an arbitrary camera rather than from behind the
tiger, which is the only way to judge anything you have to stand inside.

`scripts/drive.sh` uses these to run and screenshot the game headlessly, which is
how the visuals and every system above were verified.
