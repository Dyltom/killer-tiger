/**
 * The village after dark.
 *
 * Night used to be lit by exactly five campfire lights nailed to five fixed
 * points, which meant that anywhere else on a 240 m plain the only illumination
 * was the moonlit ambient — and that is why the night read as unplayably black
 * rather than as night.
 *
 * The fix is not "more lights". Three keys every material's shader program on
 * the scene's light count, so adding one recompiles every material in the world
 * and stalls the frame for a few hundred milliseconds; a pool that grows and
 * shrinks with what is nearby is the worst of all worlds. So the pool is
 * allocated once, at a fixed size, for the whole session — and then *dealt out*
 * each time the player moves, to whichever fires and doorways are nearest. The
 * light count never changes; only where the light is spent.
 *
 * Anchors come from village.ts: one per campfire, one per hut doorway. Lamps
 * only burn after dusk, which the day/night clock drives through `darkness`.
 */
import * as THREE from 'three'
import { LIGHTS } from '../config'
import { fbm } from '../engine/rng'

export type LampKind = 'fire' | 'lamp'

export interface LampAnchor {
  x: number
  y: number
  z: number
  kind: LampKind
  /** Desynchronises the flicker so the village doesn't pulse in unison. */
  phase: number
}

/** One pooled light, plus the fade that keeps it from popping between anchors. */
interface Slot {
  light: THREE.PointLight
  anchor: LampAnchor | null
  /** 0..1 fade. A slot changing anchor goes dark first, then moves, then lifts. */
  level: number
  wants: LampAnchor | null
}

/** Rank the anchors this often, in seconds. Nothing here moves fast. */
const REDEAL = 0.4
/** How quickly a slot fades in or out when it is handed a new anchor. */
const FADE = 3.6

export class Lamps {
  readonly anchors: LampAnchor[] = []
  private slots: Slot[] = []
  private sinceDeal = REDEAL
  /** Scratch, reused: sorting allocates nothing per frame. */
  private ranked: { a: LampAnchor; d: number }[] = []

  constructor(private parent: THREE.Object3D) {}

  /**
   * Allocate the pool. Called once, after the village has registered every
   * anchor — the lights exist from here until the page closes.
   */
  build() {
    for (let i = 0; i < LIGHTS.pool; i++) {
      // Decay exponent 2 is physical inverse-square falloff, which is what keeps
      // a fire pooling on the ground around itself instead of flatly lifting the
      // whole clearing.
      const light = new THREE.PointLight(LIGHTS.fireColor, 0, LIGHTS.fireRange, 2)
      light.castShadow = false
      // Parked at the origin with zero intensity until the first deal.
      this.parent.add(light)
      this.slots.push({ light, anchor: null, level: 0, wants: null })
    }
  }

  /**
   * Deal the pool to the nearest anchors, then drive every slot toward the
   * brightness the time of day asks for.
   *
   * @param darkness 0 in daylight, 1 at midnight. See DayNight.darkness.
   */
  update(dt: number, time: number, viewer: THREE.Vector3, darkness: number) {
    if (this.slots.length === 0) return

    this.sinceDeal += dt
    if (this.sinceDeal >= REDEAL) {
      this.sinceDeal = 0
      this.deal(viewer)
    }

    // Lamps are lit at dusk and out by sunrise; fires bank down but never go
    // fully out, so the village still has embers to run toward in daylight.
    const lit = smoothstep(LIGHTS.lightUpAt, 0.65, darkness)

    for (const s of this.slots) {
      const swapping = s.wants !== s.anchor
      const target = swapping ? 0 : 1
      s.level += (target - s.level) * Math.min(1, FADE * dt)

      if (swapping && s.level < 0.02) {
        s.anchor = s.wants
        s.level = 0
        if (s.anchor) {
          s.light.position.set(s.anchor.x, s.anchor.y, s.anchor.z)
          const fire = s.anchor.kind === 'fire'
          s.light.color.setHex(fire ? LIGHTS.fireColor : LIGHTS.lampColor)
          s.light.distance = fire ? LIGHTS.fireRange : LIGHTS.lampRange
        }
      }

      const a = s.anchor
      if (!a) {
        s.light.intensity = 0
        continue
      }

      const fire = a.kind === 'fire'
      const base = fire ? LIGHTS.fireIntensity : LIGHTS.lampIntensity
      // A fire gutters hard; an oil lamp behind a doorway barely moves.
      const flickerAmp = fire ? 0.5 : 0.12
      const flicker = 1 + (Math.abs(fbm(time * 2.4 + a.phase, a.phase, 2)) - 0.5) * flickerAmp
      // Fires keep a floor in daylight — you can see a cook fire at noon. Lamps
      // do not; a burning lamp in full sun is just a bright smudge on a wall.
      const day = fire ? LIGHTS.dayFloor + (1 - LIGHTS.dayFloor) * lit : lit
      s.light.intensity = base * s.level * flicker * day
    }
  }

  /** Rank anchors by distance and hand the closest ones to the pool. */
  private deal(viewer: THREE.Vector3) {
    this.ranked.length = 0
    for (const a of this.anchors) {
      // Fires are worth more than doorways, so bias their distance down rather
      // than sorting on distance alone: a cook fire twenty metres off is a more
      // useful light than a lamp ten metres off, and it is what the fleeing
      // villagers are running toward anyway.
      const d = Math.hypot(a.x - viewer.x, a.z - viewer.z) * (a.kind === 'fire' ? 0.55 : 1)
      this.ranked.push({ a, d })
    }
    this.ranked.sort((p, q) => p.d - q.d)

    // Slots already holding a winning anchor keep it — otherwise every deal
    // would reshuffle which slot owns which fire and the whole pool would
    // cross-fade for nothing.
    const winners = this.ranked.slice(0, this.slots.length).map((r) => r.a)
    const taken = new Set<LampAnchor>()
    for (const s of this.slots) {
      if (s.anchor && winners.includes(s.anchor)) {
        s.wants = s.anchor
        taken.add(s.anchor)
      }
    }
    let next = 0
    for (const s of this.slots) {
      if (s.wants === s.anchor && s.anchor && taken.has(s.anchor)) continue
      while (next < winners.length && taken.has(winners[next]!)) next++
      const pick = next < winners.length ? winners[next]! : null
      if (pick) taken.add(pick)
      s.wants = pick
    }
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1)))
  return t * t * (3 - 2 * t)
}
