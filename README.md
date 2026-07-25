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

No build-time asset pipeline and no network fetches — see
[Assets](#assets-everything-is-generated-at-runtime).

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

## Assets: everything is generated at runtime

There are no image, model, audio, or font files in this repository, and nothing is
downloaded at runtime. Every asset is synthesised in code on first load:

- **Textures** — drawn into 2D canvases (fur, bark, thatch, stone, cloth, grass,
  blood, terrain) with a value-noise grain pass, then uploaded as `CanvasTexture`.
- **Geometry** — low-poly `BufferGeometry` built in code. Trees, rocks, grass and
  the boundary cliffs are `InstancedMesh`.
- **Terrain** — a height field from deterministic fBm noise. `terrainHeight(x, z)`
  is a pure function that every system (tiger, humans, props, particles) shares,
  so nothing ever disagrees about where the ground is.
- **Audio** — WebAudio oscillators and shaped noise buffers. Roars, gunshots,
  screams and ambience are all synthesised per call.
- **Particles** — one pooled `Points` system with a custom shader for blood, gore,
  dust, sparks and muzzle flash.

The upside: it runs offline, loads instantly, has no licences to track, and the
whole look is tunable from `src/config.ts`.

## Layout

```
src/
├── config.ts            every tunable number in the game
├── main.ts              renderer, loop, overlay routing
├── game.ts              simulation: waves, combat, scoring, pickups, buffs
├── engine/              input, procedural audio, seeded RNG + noise
├── entities/            tiger, human, pickup, particles
├── world/               terrain, village, props, procedural textures
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
- **New ability** — follow the roar: a cooldown on `Tiger`, a key check in
  `Game.updateActions`, and an effect loop over `humans`.
- **Day/night** — `skyTexture()`, the light colours, and `COLORS.fog` are the
  only three places the time of day is expressed.
- **Bosses, objectives, weather** — `WAVE` drives all pacing; hook a special
  spawn into `Game.advanceWave`.

## Tech

TypeScript, Vite, and Three.js. Three.js was chosen over a full engine because it
gives direct control of the render loop with no editor, no asset pipeline, and no
project format — which is what makes the fully procedural approach above possible.

## Debug handle

In development, `window.__kt` exposes `game`, `world`, `camera`, `scene`, and:

- `step(frames, dt)` — advance the real loop at a fixed timestep
- `hold(code)` / `release(code)` — synthesise key input
- `click(button)` — synthesise a mouse click
- `look(dx, dy)` — feed mouse-look deltas

`scripts/drive.sh` uses these to run and screenshot the game headlessly, which is
how the visuals and every system above were verified.
