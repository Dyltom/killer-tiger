/**
 * Game rules: waves, combat resolution, scoring, pickups and buffs.
 * Rendering and the DOM live elsewhere; this file is the simulation.
 */
import * as THREE from 'three'
import { BUFFS, COMBO, HUMAN, HUT, PICKUP, STORAGE_KEY, STORY, TIGER, WAVE, WORLD } from './config'
import { audio, type Place } from './engine/audio'
import type { Input } from './engine/input'
import { clamp, Rng } from './engine/rng'
import { Human } from './entities/human'
import { Particles } from './entities/particles'
import { Pickup, PICKUP_TYPES, type PickupId } from './entities/pickup'
import { Tiger } from './entities/tiger'
import { Hud } from './ui/hud'
import { terrainHeight, World } from './world/world'

export type GameState = 'menu' | 'playing' | 'paused' | 'dead'

const MAX_HUMANS = 52
const MAX_PICKUPS = 14

/** Arterial pulses go up and out, not along the blow that caused them. */
const SPURT_UP = new THREE.Vector3(0, 1, 0)

interface ActiveBuff {
  id: keyof typeof BUFFS
  remaining: number
}

export class Game {
  state: GameState = 'menu'

  /**
   * How dark it is outside, 0..1. Written by the frame loop from the sky clock
   * before update(); the world reads it to decide whether the village lamps are
   * burning. Game does not own the sky, so it takes this rather than reaching
   * for it.
   */
  darkness = 0

  readonly tiger: Tiger
  private humans: Human[] = []
  private pickups: Pickup[] = []
  private particles: Particles
  private rng = new Rng(4242)

  score = 0
  kills = 0
  wave = 1
  private waveKills = 0
  private waveNeeded = WAVE.basePrey
  private interWave = 0

  private chain = 0
  private chainTimer = 0
  private buffs: ActiveBuff[] = []
  /** Progress on the corpse currently being eaten, 0..1. */
  private feedProgress = 0
  private feedTarget: Human | null = null
  /** Counts down to the next mouthful while feeding. */
  private chewTimer = 0
  private pickupTimer = PICKUP.spawnInterval * 0.4
  private spawnTimer = 0
  private time = 0
  /** Which forepaw the next step belongs to; only the mix cares. */
  private footIsLeft = false
  best = 0

  onStateChange: ((s: GameState) => void) | null = null

  constructor(
    private scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    private world: World,
    private hud: Hud,
  ) {
    this.tiger = new Tiger(camera, world)
    this.particles = new Particles(scene)

    for (let i = 0; i < MAX_HUMANS; i++) {
      const h = new Human(1000 + i * 37)
      h.group.visible = false
      scene.add(h.group)
      this.humans.push(h)
    }
    for (let i = 0; i < MAX_PICKUPS; i++) {
      const p = new Pickup()
      scene.add(p.group)
      this.pickups.push(p)
    }
    this.best = this.loadBest()
  }

  // --------------------------------------------------------------- storage
  private loadBest(): number {
    try {
      return Number(localStorage.getItem(STORAGE_KEY) ?? 0) || 0
    } catch {
      return 0
    }
  }
  private saveBest() {
    try {
      if (this.score > this.best) {
        this.best = this.score
        localStorage.setItem(STORAGE_KEY, String(this.best))
      }
    } catch {
      /* private browsing — best score just won't persist */
    }
  }

  // ------------------------------------------------------------ lifecycle
  start() {
    // Everybody is out of the huts again. The counts live on the world, which
    // outlives a round.
    this.world.resetHuts()
    this.score = 0
    this.kills = 0
    this.wave = 1
    this.waveKills = 0
    this.waveNeeded = WAVE.basePrey
    this.interWave = 0
    this.chain = 0
    this.chainTimer = 0
    this.buffs = []
    this.feedProgress = 0
    this.feedTarget = null
    this.hud.setDevour(-1)
    this.pickupTimer = PICKUP.spawnInterval * 0.4
    this.spawnTimer = 0
    this.rng = new Rng(4242)

    for (const h of this.humans) {
      h.alive = false
      h.group.visible = false
    }
    for (const p of this.pickups) p.despawn()

    this.tiger.reset()
    this.fillWave(true)
    this.setState('playing')
    audio.setMusicMode('hunt')
    audio.setWave(this.wave)
    audio.waveStart(this.wave)
    this.tellStory('good')
  }

  private setState(s: GameState) {
    if (this.state === s) return
    this.state = s
    this.onStateChange?.(s)
  }

  pause() { if (this.state === 'playing') this.setState('paused') }
  resume() { if (this.state === 'paused') this.setState('playing') }

  private die() {
    this.saveBest()
    this.setState('dead')
    audio.gameOver()
    this.tiger.shake(1.2)
  }

  // ----------------------------------------------------------------- waves
  private get waveScale() {
    return (this.wave - 1) * WAVE.healthScale
  }

  private desiredVillagers() {
    return Math.min(WAVE.villagerMax, WAVE.villagerBase + (this.wave - 1) * WAVE.villagerStep)
  }
  private desiredHunters() {
    return Math.min(WAVE.hunterMax, Math.round(WAVE.hunterBase + (this.wave - 1) * WAVE.hunterStep))
  }

  private freeHuman(): Human | null {
    for (const h of this.humans) {
      if (!h.alive && (!h.group.visible || h.expired)) return h
    }
    return null
  }

  private countAlive(kind: 'villager' | 'hunter'): number {
    let n = 0
    for (const h of this.humans) if (h.alive && h.kind === kind) n++
    return n
  }

  /** Spawn out of sight where possible, so people don't pop in front of you. */
  private spawnPointAwayFromTiger(minDist: number): THREE.Vector3 {
    let best = this.world.randomOpenPoint(12, WORLD.bounds - 12, this.rng)
    let bestD = -1
    for (let i = 0; i < 14; i++) {
      const p = this.world.randomOpenPoint(12, WORLD.bounds - 12, this.rng)
      const d = Math.hypot(p.x - this.tiger.pos.x, p.z - this.tiger.pos.z)
      const hidden = this.world.losBlocked(p.x, p.z, this.tiger.pos.x, this.tiger.pos.z) ? 14 : 0
      const scoreP = d + hidden
      if (scoreP > bestD) { bestD = scoreP; best = p }
      if (d > minDist && hidden > 0) break
    }
    return best
  }

  private distToTiger(p: THREE.Vector3): number {
    return Math.hypot(p.x - this.tiger.pos.x, p.z - this.tiger.pos.z)
  }

  private fillWave(initial: boolean) {
    const wantV = this.desiredVillagers()
    const wantH = this.desiredHunters()
    let toSpawn = 0
    toSpawn += Math.max(0, wantV - this.countAlive('villager'))
    toSpawn += Math.max(0, wantH - this.countAlive('hunter'))
    // Trickle in during play; fill instantly at wave start.
    const budget = initial ? toSpawn : 1

    for (let i = 0; i < budget; i++) {
      const needV = this.desiredVillagers() - this.countAlive('villager')
      const needH = this.desiredHunters() - this.countAlive('hunter')
      if (needV <= 0 && needH <= 0) return
      const kind: 'villager' | 'hunter' = needH > 0 && (needV <= 0 || this.rng.chance(0.35)) ? 'hunter' : 'villager'
      const h = this.freeHuman()
      if (!h) return
      let p = initial
        ? this.world.randomOpenPoint(kind === 'hunter' ? 22 : 8, 62, this.rng)
        : this.spawnPointAwayFromTiger(46)
      // Never materialise someone in the tiger's lap.
      for (let t = 0; t < 8 && this.distToTiger(p) < 24; t++) {
        p = initial ? this.world.randomOpenPoint(8, 62, this.rng) : this.spawnPointAwayFromTiger(46)
      }
      h.spawn(kind, p, this.waveScale)
    }
  }

  private advanceWave() {
    this.wave++
    this.waveKills = 0
    this.waveNeeded = WAVE.basePrey + (this.wave - 1) * WAVE.preyStep
    this.interWave = WAVE.interWaveDelay
    this.tiger.heal(22)
    this.tiger.addRage(20)
    audio.setWave(this.wave)
    audio.waveStart(this.wave)
    this.tellStory('bad')
    this.spawnPickupNear(this.tiger.pos, 'meat')
  }

  /** The beat for the current hunt, with the odds against you appended to it. */
  private tellStory(tone: 'good' | 'bad') {
    const beat = STORY[Math.min(this.wave, STORY.length) - 1]!
    const hunters = this.desiredHunters()
    const odds = hunters > 0 ? ` — ${hunters} rifle${hunters > 1 ? 's' : ''}` : ''
    this.hud.announce(beat.title, beat.line + odds)
    this.hud.toast(beat.toast, tone)
  }

  // --------------------------------------------------------------- pickups
  private freePickup(): Pickup | null {
    for (const p of this.pickups) if (!p.active) return p
    return null
  }
  private activePickups(): number {
    let n = 0
    for (const p of this.pickups) if (p.active) n++
    return n
  }

  private randomPickupId(): PickupId {
    const roll = this.rng.next()
    if (roll < 0.34) return 'meat'
    if (roll < 0.52) return 'adrenaline'
    if (roll < 0.68) return 'ironClaws'
    if (roll < 0.8) return 'ironHide'
    if (roll < 0.93) return 'relic'
    return 'rageIdol'
  }

  private spawnPickupNear(p: THREE.Vector3, id: PickupId) {
    const slot = this.freePickup()
    if (!slot) return
    const a = this.rng.range(0, Math.PI * 2)
    const r = this.rng.range(0.8, 2.0)
    const x = clamp(p.x + Math.cos(a) * r, -WORLD.bounds + 2, WORLD.bounds - 2)
    const z = clamp(p.z + Math.sin(a) * r, -WORLD.bounds + 2, WORLD.bounds - 2)
    slot.spawn(id, x, z)
  }

  private collectPickup(p: Pickup) {
    const def = PICKUP_TYPES[p.id]
    const pos = p.group.position.clone()
    pos.y += 0.4
    this.particles.pop(pos, ((def.color >> 16) & 255) / 255, ((def.color >> 8) & 255) / 255, (def.color & 255) / 255, 24)
    p.despawn()

    switch (p.id) {
      case 'meat':
        this.tiger.heal(26)
        audio.pickup()
        this.hud.toast('+26 health', 'good')
        break
      case 'relic':
        this.addScore(400, 'Gold relic')
        audio.powerup()
        break
      case 'rageIdol':
        this.tiger.addRage(55)
        audio.powerup()
        this.hud.toast('Blood idol — rage surges', 'good')
        break
      case 'adrenaline':
        this.applyBuff('adrenaline')
        break
      case 'ironClaws':
        this.applyBuff('ironClaws')
        break
      case 'ironHide':
        this.applyBuff('ironHide')
        break
    }
  }

  // --------------------------------------------------------------- feeding
  /**
   * Standing over a fresh kill and holding still eats it.
   *
   * Pickups alone made healing a scavenger hunt — you had to survive long
   * enough for one to spawn somewhere else. A tiger's food is the thing it just
   * killed, so the bodies are the economy: they are always exactly where the
   * fighting was, and stopping to eat one in the open is the risk that pays
   * for the health.
   */
  private updateFeeding(dt: number) {
    const moving = Math.hypot(this.tiger.vel.x, this.tiger.vel.z) > 1.6
    let nearest: Human | null = null
    let bestD = HUMAN.feedRadius

    for (const h of this.humans) {
      if (!h.feedable) continue
      const d = Math.hypot(h.pos.x - this.tiger.pos.x, h.pos.z - this.tiger.pos.z)
      if (d < bestD) { bestD = d; nearest = h }
    }

    if (!nearest || moving) {
      if (this.feedProgress > 0) this.feedProgress = Math.max(0, this.feedProgress - dt * 1.6)
      this.feedTarget = nearest && !moving ? nearest : null
      this.hud.setDevour(nearest ? this.feedProgress / HUMAN.feedTime : -1)
      return
    }

    if (this.feedTarget !== nearest) {
      this.feedTarget = nearest
      this.feedProgress = 0
      this.chewTimer = 0
    }
    this.feedProgress += dt
    this.hud.setDevour(this.feedProgress / HUMAN.feedTime)

    // Feeding used to be silent right up until it paid out, and then it played
    // the kill sound — so the act had no voice and its reward was ambiguous.
    // Chewing on an irregular beat gives the wait its own identity, and the
    // beat tightens as the meal goes on so the bar filling is audible.
    this.chewTimer -= dt
    if (this.chewTimer <= 0) {
      audio.chew()
      const urgency = this.feedProgress / HUMAN.feedTime
      this.chewTimer = (0.42 - urgency * 0.13) * (0.8 + this.rng.next() * 0.45)
    }

    if (this.feedProgress >= HUMAN.feedTime) {
      nearest.feed()
      this.feedProgress = 0
      this.feedTarget = null
      this.tiger.heal(HUMAN.feedHeal)
      this.tiger.addRage(HUMAN.feedRage)
      this.score += HUMAN.feedScore
      this.particles.gore(nearest.woundPos, 14)
      this.tiger.shake(0.2)
      // A swallow, not a kill. This is the moment the health lands, and it has
      // to read as *feeding finished* rather than as *something just died*.
      audio.gulp(true)
      this.hud.toast(`Fed — +${HUMAN.feedHeal} health`, 'good')
      // Eating a hunter is worth a buff on top; their bodies are the good ones.
      if (nearest.kind === 'hunter') this.applyBuff('ironHide')
    }
  }

  private applyBuff(id: keyof typeof BUFFS) {
    const def = BUFFS[id]
    const existing = this.buffs.find((b) => b.id === id)
    if (existing) existing.remaining = def.duration
    else this.buffs.push({ id, remaining: def.duration })
    audio.powerup()
    this.hud.toast(`${def.label} active`, 'good')
  }

  private recomputeBuffs() {
    this.tiger.speedMult = 1
    this.tiger.damageMult = 1
    this.tiger.damageTakenMult = 1
    for (const b of this.buffs) {
      if (b.id === 'adrenaline') this.tiger.speedMult *= BUFFS.adrenaline.speedMult
      if (b.id === 'ironClaws') this.tiger.damageMult *= BUFFS.ironClaws.damageMult
      if (b.id === 'ironHide') this.tiger.damageTakenMult *= BUFFS.ironHide.damageTaken
    }
  }

  private get bloodScent(): boolean {
    return this.buffs.some((b) => b.id === 'bloodScent')
  }

  // --------------------------------------------------------------- scoring
  private get comboMult(): number {
    return Math.min(COMBO.max, 1 + Math.max(0, this.chain - 1) * COMBO.step)
  }

  private addScore(base: number, label: string) {
    const gained = Math.round(base * this.comboMult)
    this.score += gained
    this.hud.toast(`+${gained}  ${label}`, 'kill')
  }

  // ---------------------------------------------------------------- combat
  private resolveAttack() {
    const atk = this.tiger.pendingAttack
    if (!atk) return
    const eye = atk.origin
    let hitAny = false
    let killedAny = false

    for (const h of this.humans) {
      if (!h.alive) continue
      const dx = h.pos.x - eye.x
      const dz = h.pos.z - eye.z
      const dy = h.pos.y + 0.9 - eye.y
      const dist = Math.hypot(dx, dy, dz)
      if (dist > atk.range) continue
      const inv = 1 / (dist || 1)
      const dot = (dx * inv) * atk.dir.x + (dy * inv) * atk.dir.y + (dz * inv) * atk.dir.z
      if (Math.acos(clamp(dot, -1, 1)) > atk.arc + 0.35) continue

      hitAny = true
      const dir = new THREE.Vector3(dx, dy, dz).normalize()
      // Where on the body it actually landed, rather than the middle of the
      // chest every time. Follow the swing out to the target and take the
      // height it arrives at: a claw thrown from a crouch opens a belly and one
      // thrown at full height opens a shoulder. A bite goes for the throat, so
      // it is allowed further up than a paw is.
      const landY = clamp(
        eye.y + atk.dir.y * dist,
        h.pos.y + 0.6,
        h.pos.y + (atk.kind === 'bite' ? 1.62 : 1.46),
      )
      const hitPoint = new THREE.Vector3(h.pos.x, landY, h.pos.z)
      // Killing bite from behind an unaware target is an instant execution.
      const behind = this.isBehind(h, eye)
      const stealth = behind && !h.alerted && atk.kind === 'bite'
      const damage = stealth ? 9999 : atk.damage

      // Read before the blow lands: dying clears the hut, and by the time
      // `hurt` returns there is no way left to tell where he thought he was.
      const cornered = h.hiding
      const killed = h.hurt(damage, eye, atk.kind === 'bite' ? 'bite' : 'claw', hitPoint)
      // Spray from the wound the body just decided on, not from the axis point
      // we handed it — otherwise the blood leaves from inside the man.
      this.particles.blood(h.woundPos, dir, killed ? 34 : 16, killed ? 1.4 : 0.8)
      if (killed) {
        killedAny = true
        this.onKill(
          h,
          cornered ? 'Dragged from the hut'
            : stealth ? 'Silent kill'
            : atk.kind === 'bite' ? 'Throat torn'
            : 'Mauled',
          cornered ? HUT.hiddenKillBonus : 1,
        )
        if (atk.kind === 'bite') this.tiger.heal(TIGER.biteHeal)
      } else {
        audio.clawHit(this.placeOf(h.pos))
        audio.scream(this.placeOf(h.pos), h.kind === 'hunter' ? 0.85 : 1.05)
      }
      // Claws cleave: keep going and hit everyone in the arc.
      if (atk.kind === 'bite') break
    }

    // The viewmodel only knows it connected because we tell it — this is what
    // turns a swipe through empty air into a swipe that stops against a body.
    this.tiger.onAttackResult(hitAny, killedAny)

    if (hitAny) {
      this.hud.hitMarker(killedAny)
      this.tiger.shake(killedAny ? 0.32 : 0.14)
      if (atk.kind === 'bite') audio.biteKill()
    } else {
      // A swing through empty air still costs the tiger a breath.
      audio.growl()
    }
  }

  private isBehind(h: Human, from: THREE.Vector3): boolean {
    const fx = -Math.sin(h.yaw)
    const fz = -Math.cos(h.yaw)
    const dx = from.x - h.pos.x
    const dz = from.z - h.pos.z
    const d = Math.hypot(dx, dz) || 1
    return (dx / d) * fx + (dz / d) * fz < -0.25
  }

  /** Tackling someone mid-pounce is an automatic takedown. */
  private resolvePounceTackles() {
    if (!this.tiger.pouncing) return
    const speed = Math.hypot(this.tiger.vel.x, this.tiger.vel.z)
    if (speed < 6) return
    for (const h of this.humans) {
      if (!h.alive) continue
      const d = Math.hypot(h.pos.x - this.tiger.pos.x, h.pos.z - this.tiger.pos.z)
      if (d > TIGER.radius + HUMAN.radius + 0.7) continue
      if (Math.abs(h.pos.y + 1 - this.tiger.pos.y) > 2.4) continue

      const dir = new THREE.Vector3(this.tiger.vel.x, 0.4, this.tiger.vel.z).normalize()
      h.hurt(9999, this.tiger.pos, 'bite')
      this.particles.blood(h.woundPos, dir, 40, 1.6)
      this.particles.gore(h.woundPos, 16)
      this.onKill(h, 'POUNCE TAKEDOWN')
      this.tiger.shake(0.55)
      this.tiger.heal(8)
      // Bleed off some momentum so you land on the body rather than sailing past.
      this.tiger.vel.x *= 0.35
      this.tiger.vel.z *= 0.35
      break
    }
  }

  private onKill(h: Human, label: string, bonus = 1) {
    this.kills++
    this.waveKills++
    this.chain++
    this.chainTimer = COMBO.window
    if (this.chain > 1) audio.comboTick(this.chain)

    const cfg = h.kind === 'hunter' ? HUMAN.hunter : HUMAN.villager
    this.addScore(cfg.score * bonus, label)
    this.tiger.addRage(cfg.rage)

    this.particles.gore(h.woundPos, h.kind === 'hunter' ? 20 : 14)
    // No decal here. A body travels most of its own length going down, so a
    // pool stamped where the feet were lands beside the corpse rather than
    // under it — and it lands instantly, which is a pool that was already
    // there. The corpse asks for its own now, from where its chest ends up and
    // over the seconds it takes to make one. See Human.poolPulse.
    audio.biteKill(this.placeOf(h.pos))
    audio.scream(this.placeOf(h.pos), h.kind === 'hunter' ? 0.8 : 1.1)

    // Panic ripples outward — nearby witnesses break.
    for (const other of this.humans) {
      if (!other.alive || other === h) continue
      const d = Math.hypot(other.pos.x - h.pos.x, other.pos.z - h.pos.z)
      if (d < 16) {
        other.alertTo(this.tiger.pos)
        if (d < 9 && other.kind === 'villager') other.terrify(2.4, 0)
      }
    }

    // Drop rate: hunters carry better loot.
    if (this.activePickups() < PICKUP.maxAlive) {
      const roll = this.rng.next()
      if (h.kind === 'hunter') {
        if (roll < 0.75) this.spawnPickupNear(h.pos, roll < 0.3 ? 'meat' : this.randomPickupId())
      } else if (roll < 0.42) {
        this.spawnPickupNear(h.pos, roll < 0.3 ? 'meat' : this.randomPickupId())
      }
    }

    if (this.waveKills >= this.waveNeeded && this.interWave <= 0) this.advanceWave()
  }

  private roar() {
    if (!this.tiger.canRoar) return
    this.tiger.roarCd = TIGER.roarCooldown
    audio.roar()
    this.tiger.shake(0.5)
    this.particles.dust(this.tiger.pos, 26, 0.5)

    let affected = 0
    for (const h of this.humans) {
      if (!h.alive) continue
      const d = Math.hypot(h.pos.x - this.tiger.pos.x, h.pos.z - this.tiger.pos.z)
      if (d > TIGER.roarRadius) continue
      affected++
      // Falls off with distance: close targets are frozen, far ones just spooked.
      const t = 1 - d / TIGER.roarRadius
      h.terrify(TIGER.roarFearDuration * (0.5 + t * 0.5), TIGER.roarStagger * t)
    }
    if (affected > 0) this.hud.toast(`Roar — ${affected} scattered`, 'good')
  }

  /**
   * Where a sound is, from the tiger's ears: stereo angle and range.
   *
   * The audio engine does the rest — attenuation, the treble the air eats on
   * the way over, how much of the valley comes back with it, and for a rifle
   * how late it arrives. All this has to know is the geometry.
   */
  private placeOf(p: THREE.Vector3): Place {
    // Project the offset onto the tiger's right vector for stereo placement.
    const dx = p.x - this.tiger.pos.x
    const dz = p.z - this.tiger.pos.z
    const rx = Math.cos(this.tiger.yaw)
    const rz = -Math.sin(this.tiger.yaw)
    const d = Math.hypot(dx, dz) || 1
    return { pan: clamp(((dx * rx + dz * rz) / d) * 0.85, -1, 1), dist: d }
  }

  // ---------------------------------------------------------------- update
  update(dt: number, input: Input, locked: boolean) {
    this.time += dt
    this.world.update(dt, this.time, this.tiger.pos, this.darkness)
    this.particles.update(dt)
    this.hud.updateFeed(dt)

    if (this.state !== 'playing') {
      // Keep the camera alive so the menu isn't a frozen frame.
      this.tiger.update(dt, input, false)
      return
    }

    if (locked) {
      if (input.pressed('KeyR')) this.roar()
      if (input.pressed('KeyQ') && this.tiger.startFrenzy()) {
        audio.frenzyStart()
        this.hud.announce('BLOOD FRENZY', 'Everything dies faster')
        this.hud.toast('BLOOD FRENZY', 'bad')
      }
    }

    this.recomputeBuffs()
    this.tiger.update(dt, input, locked)
    this.resolveAttack()
    this.resolvePounceTackles()

    // The swing has to be heard before the hit lands, so this fires off the
    // frame the animation starts rather than off the contact frame.
    if (this.tiger.swingEvent !== 0) {
      audio.swipeWhoosh(this.tiger.swingEvent, this.tiger.swingIsBite)
    }
    // Paws alternate, so the step alternates across the stereo field with them.
    if (this.tiger.footstepEvent) {
      this.footIsLeft = !this.footIsLeft
      audio.footstep({ pan: this.footIsLeft ? -0.28 : 0.28 }, this.tiger.sprinting)
    }
    if (this.tiger.landedEvent) {
      // How hard it hit, not just that it did. A step off a kerb and the end of
      // a full pounce arc are the same event to the game and very different
      // sounds; 8 m/s is about a flat run's worth of drop.
      audio.land(this.tiger.landImpact / 8)
      this.particles.dust(this.tiger.pos, 8, 0.45)
    }
    if (this.tiger.pounceEvent) audio.pounce()

    this.updateHumans(dt)
    this.updateFeeding(dt)
    this.updatePickups(dt)
    this.updateTimers(dt)
    this.updateHud()

    if (this.tiger.health <= 0) this.die()
  }

  private updateHumans(dt: number) {
    const vis = this.tiger.visibility
    const noise = this.tiger.noise
    let alerted = 0
    let huntersOnMe = 0

    for (const h of this.humans) {
      if (!h.group.visible) continue
      h.update(dt, this.tiger.pos, vis, noise, this.world, this.waveScale)

      // A body keeps emptying itself out for a couple of seconds after it
      // drops. The spurt comes off the wound; the pool under it is stamped on
      // the corpse's own schedule, from wherever its chest actually settled.
      if (h.bleedPulse) this.particles.blood(h.woundPos, SPURT_UP, 12, 0.7)
      if (h.poolPulse) {
        this.world.addBloodDecal(h.poolPos.x, h.poolPos.z, h.poolScale)
      }

      if (!h.alive) continue
      if (h.alerted) {
        alerted++
        if (h.kind === 'hunter') huntersOnMe++
      }

      // Someone spotted the tiger and yelled — everyone nearby now knows.
      if (h.pendingShout) {
        audio.shout(this.placeOf(h.pos), h.kind === 'hunter' ? 0.85 : 1.15)
        for (const other of this.humans) {
          if (other === h || !other.alive) continue
          if (Math.hypot(other.pos.x - h.pos.x, other.pos.z - h.pos.z) < HUMAN.alertShoutRadius) {
            other.alertTo(this.tiger.pos)
          }
        }
      }

      if (h.pendingShot) {
        const shot = h.pendingShot
        const dist = Math.hypot(h.pos.x - this.tiger.pos.x, h.pos.z - this.tiger.pos.z)
        audio.gunshot(this.placeOf(h.pos), dist)
        this.particles.muzzle(
          new THREE.Vector3(shot.origin.x + shot.dir.x * 0.7, shot.origin.y, shot.origin.z + shot.dir.z * 0.7),
          shot.dir,
        )
        if (shot.hit) {
          this.hud.flashDamage()
          audio.hurt()
          this.particles.blood(this.tiger.eyePos().addScaledVector(shot.dir, 0.6), shot.dir, 10, 0.5)
          if (this.tiger.takeDamage(shot.damage)) {
            this.die()
            return
          }
          // Getting shot breaks your chain — pressure to keep moving.
          this.chainTimer = Math.min(this.chainTimer, 0.9)
        } else {
          audio.bulletWhiz(this.placeOf(h.pos))
        }
      }
    }

    this.hud.setThreat(alerted, huntersOnMe)
    this.driveScore(alerted, huntersOnMe)
  }

  /**
   * What the score is reacting to.
   *
   * Rifles pointed at you are worth the most, because that is the situation the
   * arrangement was written for. Everything else is a modifier: a village that
   * has woken up, a health bar in the red, a chain going, and frenzy, which
   * simply pins it. The score smooths this itself — fast on the way up, slow on
   * the way down — so a single shout does not detonate the whole orchestra.
   */
  private driveScore(alerted: number, huntersOnMe: number) {
    const threat = Math.min(1, huntersOnMe * 0.3 + alerted * 0.045)
    const wounded = 1 - this.tiger.health / TIGER.maxHealth
    const chain = Math.min(1, this.chain / 5)
    const intensity = clamp(
      threat + wounded * 0.3 + chain * 0.2 + (this.tiger.frenzy > 0 ? 0.6 : 0),
      0,
      1,
    )
    audio.setIntensity(intensity)
    audio.setFrenzy(this.tiger.frenzy > 0)
    audio.setAmbience(this.darkness, this.wave)
  }

  private updatePickups(dt: number) {
    this.pickupTimer -= dt
    if (this.pickupTimer <= 0) {
      this.pickupTimer = PICKUP.spawnInterval
      if (this.activePickups() < PICKUP.maxAlive) {
        const slot = this.freePickup()
        if (slot) {
          const sp = this.world.spawnPoints[this.rng.int(0, this.world.spawnPoints.length - 1)]
          if (sp) slot.spawn(this.randomPickupId(), sp.x, sp.z)
        }
      }
    }

    for (const p of this.pickups) {
      p.update(dt, this.time)
      if (!p.active) continue
      const d = Math.hypot(p.group.position.x - this.tiger.pos.x, p.group.position.z - this.tiger.pos.z)
      if (d < PICKUP.grabRadius && Math.abs(p.group.position.y - this.tiger.pos.y) < 3) {
        this.collectPickup(p)
      }
    }
  }

  private updateTimers(dt: number) {
    if (this.chainTimer > 0) {
      this.chainTimer -= dt
      if (this.chainTimer <= 0) this.chain = 0
    }
    for (let i = this.buffs.length - 1; i >= 0; i--) {
      const b = this.buffs[i]!
      b.remaining -= dt
      if (b.remaining <= 0) {
        this.hud.toast(`${BUFFS[b.id].label} faded`, 'bad')
        this.buffs.splice(i, 1)
      }
    }
    if (this.interWave > 0) {
      this.interWave -= dt
      if (this.interWave <= 0) this.fillWave(true)
    } else {
      this.spawnTimer -= dt
      if (this.spawnTimer <= 0) {
        this.spawnTimer = 2.2
        this.fillWave(false)
      }
    }
  }

  private updateHud() {
    this.hud.setScore(this.score)
    this.hud.setCombo(this.chain, this.comboMult)
    this.hud.setWave(this.wave, this.waveKills, this.waveNeeded)
    this.hud.setMeters(
      this.tiger.health / TIGER.maxHealth,
      this.tiger.stamina / TIGER.maxStamina,
      this.tiger.rage / TIGER.maxRage,
      this.tiger.frenzy > 0,
    )
    this.hud.setFrenzy(this.tiger.frenzy > 0)
    this.hud.setBuffs(this.buffs.map((b) => ({ label: BUFFS[b.id].label, remaining: b.remaining })))
    this.hud.setReticleHot(this.nearestPreyDistance() < TIGER.clawRange)
    this.hud.drawRadar(
      this.tiger.pos.x, this.tiger.pos.z, this.tiger.yaw,
      this.humans, this.pickups, this.bloodScent,
    )
  }

  private nearestPreyDistance(): number {
    const eye = this.tiger.eyePos()
    const dir = this.tiger.lookDir()
    let best = Infinity
    for (const h of this.humans) {
      if (!h.alive) continue
      const dx = h.pos.x - eye.x
      const dz = h.pos.z - eye.z
      const dy = h.pos.y + 0.9 - eye.y
      const d = Math.hypot(dx, dy, dz)
      if (d > TIGER.clawRange) continue
      const dot = (dx * dir.x + dy * dir.y + dz * dir.z) / (d || 1)
      if (Math.acos(clamp(dot, -1, 1)) < TIGER.clawArc + 0.35) best = Math.min(best, d)
    }
    return best
  }

  /** Used by the ambient flame meshes so the world keeps breathing. */
  get elapsed() { return this.time }

  dispose() {
    this.scene.clear()
  }
}

export { terrainHeight }
