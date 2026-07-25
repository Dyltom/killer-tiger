/**
 * Prey and predators-of-the-predator.
 *
 * Villagers wander, notice the tiger, and scatter screaming toward firelight.
 * Hunters patrol, close the distance, and shoot. Both share one body rig and
 * one state machine; the differences are in the config table and the brain.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { HUMAN } from '../config'
import { clamp, damp, Rng } from '../engine/rng'
import { textures } from '../world/textures'
import { terrainHeight, World } from '../world/world'

export type HumanKind = 'villager' | 'hunter'
export type HumanState = 'wander' | 'suspicious' | 'flee' | 'hunt' | 'panic' | 'dead'

export interface ShotEvent {
  origin: THREE.Vector3
  dir: THREE.Vector3
  damage: number
  hit: boolean
}

// Darker than they look on a swatch. The sun is 3.3 intensity and the grade
// adds contrast on top, so anything above about 0xc08150 clips to featureless
// white the moment a villager steps out of shade.
const SKIN = [0x6d4527, 0x7d5433, 0x4f301d, 0x86593a, 0x412818]
const SHIRT = [0x59653f, 0x71462c, 0x3d4a58, 0x655840, 0x7d684a, 0x4a3b2e]
const HUNTER_SHIRT = [0x333d2a, 0x3d3325, 0x2b333c]
const TROUSER = [0x3d3527, 0x4a4030, 0x2e2a22, 0x554c3c, 0x6a6152, 0x484030]
const HAIR = [0x241a13, 0x1b1410, 0x3a2a1c]
const GREY = [0x6e665c, 0x857d72]
const TURBAN = [0xb0a48b, 0xa5522c, 0xbdb39c, 0x5f7488, 0xa8873c, 0x93362d]

/** Leather, felt and brass on the hunters' kit. */
const LEATHER = 0x513520
const FELT = 0x3f342a
const BRASS = 0xa9853f

/** Tapered tube hanging *down* from `y`: it spans y - len to y. */
function seg(r0: number, r1: number, len: number, y: number, radial = 8): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r0, r1, len, radial)
  g.translate(0, y - len / 2, 0)
  return g
}

function ball(r: number, y: number, x = 0, z = 0, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 10, 8)
  g.scale(sx, sy, sz)
  g.translate(x, y, z)
  return g
}

/** Open-ended band, for belts and hat crowns. */
function band(r: number, h: number, y: number, sz = 1): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, h, 16, 1, true)
  g.scale(1, 1, sz)
  g.translate(0, y, 0)
  return g
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return mergeGeometries(parts, false)!
}

/**
 * Bake a colour into a geometry's vertices.
 *
 * Hair, beard, turban and headwear all want different colours but have to stay
 * in one mesh — with fifty-odd humans alive, splitting a head across four
 * materials is two hundred draw calls for something nobody looks at up close.
 * Vertex colours put all four in one buffer for free.
 */
function tint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex)
  const n = g.attributes.position!.count
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r
    arr[i * 3 + 1] = c.g
    arr[i * 3 + 2] = c.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3))
  return g
}

/** Fresh in the wound, and the darker stain it leaves in cloth. */
const WET_BLOOD = new THREE.Color(0x8c0d10)
const SOAKED = new THREE.Color(0x3a0709)

export class Human {
  readonly group = new THREE.Group()
  readonly pos = new THREE.Vector3()
  readonly vel = new THREE.Vector3()
  kind: HumanKind = 'villager'
  state: HumanState = 'wander'
  health = 60
  maxHealth = 60
  alive = true
  yaw = 0

  /** Awareness of the tiger, 0..1. Crosses 1 -> the human is certain. */
  awareness = 0
  alerted = false
  /** Set by roar / a nearby kill. */
  fearTimer = 0
  staggerTimer = 0

  private target = new THREE.Vector3()
  private repathTimer = 0
  private fireTimer = 0
  private aimTimer = 0
  private stepPhase = 0
  private deathTimer = 0
  private hurtFlash = 0
  private rng: Rng

  /** Lean away from the last blow, in body-local x/z. Decays back to nothing. */
  private leanX = 0
  private leanZ = 0
  /** Which way the body falls when it dies, in body-local space. */
  private fallX = 1
  private fallZ = 0
  private bleedTimer = 0
  private bleedNext = 0
  private fed = false

  /** Rig parts we animate. */
  private legL!: THREE.Mesh
  private legR!: THREE.Mesh
  private armL!: THREE.Mesh
  private armR!: THREE.Mesh
  private torso!: THREE.Mesh
  private head!: THREE.Mesh
  private rifle: THREE.Group | null = null
  /** Hunter-only kit: bandolier and belt on the body, slouch hat on the head. */
  private kitBody: THREE.Mesh | null = null
  private kitHat: THREE.Mesh | null = null
  /** A turban already fills the space a hat would go, so this slot never gets one. */
  private turbaned = false
  private wounds!: THREE.Mesh
  private woundMat!: THREE.MeshStandardMaterial
  private body = new THREE.Group()
  private mats: THREE.MeshStandardMaterial[] = []

  pendingShot: ShotEvent | null = null
  pendingShout = false
  screamed = false
  /** Set for one frame each time the corpse pumps out another gout of blood. */
  bleedPulse = false
  /** Where the last wound was opened, in world space. */
  readonly woundPos = new THREE.Vector3()

  constructor(seed: number) {
    this.rng = new Rng(seed)
    this.buildRig()
    this.group.add(this.body)
  }

  // ----------------------------------------------------------------- rig
  /**
   * A villager is six meshes — torso, head, hair, two arms, two legs — because
   * with fifty-two slots in the pool every extra mesh is another fifty draw
   * calls. Each of those meshes is several primitives merged into one buffer,
   * which costs nothing at draw time and is the difference between a stack of
   * cuboids and something with shoulders, a jaw and knees.
   *
   * Everything that varies between people is baked here, once, because the
   * geometry can't change when a slot is recycled: build, sleeve length, hair,
   * headwear, beard. Colours are the only thing spawn() can still touch. That
   * constraint is also why none of the variety can be kind-specific — any slot
   * may come back as either a villager or a hunter, so the hunters' kit is a
   * pair of meshes toggled on top rather than a different body.
   *
   * Pivots are unchanged: limbs still hang from their top vertex and the torso
   * and head still rotate about their centres, so the animation code below
   * drives this rig as it drove the old one.
   */
  private buildRig() {
    const tex = textures()
    const rng = this.rng
    const skin = new THREE.MeshStandardMaterial({ color: rng.pick(SKIN), roughness: 0.9 })
    const shirt = new THREE.MeshStandardMaterial({ map: tex.cloth, color: 0xffffff, roughness: 1 })
    const pants = new THREE.MeshStandardMaterial({ color: 0x3d3527, roughness: 1 })
    this.mats = [skin, shirt, pants]

    // Build. Height and girth vary independently, which is what separates a
    // crowd from a row of the same doll at slightly different sizes: one
    // uniform scale makes everyone the same shape, and shape is what you read
    // at forty metres through grass.
    const tall = rng.range(0.92, 1.08)
    const wide = rng.range(0.88, 1.15)
    // Sleeve length. Cheap, but it changes the arm silhouette, and half the
    // village being in short sleeves and half in long is more variety than any
    // amount of recolouring buys.
    const cuff = rng.pick([0.2, 0.2, 0.44, 0.0])

    // Tapered, and started up inside the shoulder ball: a straight tube of
    // constant radius reads as a pauldron bolted to the side of the chest,
    // which is exactly what long sleeves looked like before the taper.
    const sleeve = (x: number) => {
      const g = new THREE.CylinderGeometry(0.098, cuff > 0.3 ? 0.058 : 0.078, cuff, 10)
      g.translate(x, 0.26 - cuff / 2, 0)
      return g
    }

    // ---- torso: oval in section, wider at the shoulders than the waist.
    // Local origin sits at chest height; the mesh is parked at y 1.16 so the
    // body still spans roughly 0.85 to 1.47 as before.
    // seg() hangs downward, so the chest is anchored by its *top* at +0.24 —
    // level with the shoulder balls the arms swing from.
    const torsoParts = [
      seg(0.2, 0.155, 0.48, 0.24, 12).scale(1, 1, 0.62),
      ball(0.17, -0.25, 0, 0, 1, 0.85, 0.66), // hips
      // A wrap over the hips. Without it the legs read as bare from the waist
      // down, which makes every villager look like they are in their
      // underwear. Kept short and a touch wider than the hips so a swinging
      // thigh doesn't punch through the static cloth.
      seg(0.2, 0.195, 0.26, -0.2).scale(1, 1, 0.72),
      ball(0.098, 0.205, -0.185, 0, 1, 1, 0.82),
      ball(0.098, 0.205, 0.185, 0, 1, 1, 0.82),
    ]
    // Sleeves. Built into the torso rather than into the arm so they cost
    // nothing: an arm split across two materials would be two draw calls each,
    // and at fifty humans that is two hundred extra. The arm swings inside the
    // cuff, which is what a real sleeve does. A zero cuff is the sleeveless
    // one, and gets a collar band instead so the shirt still has a neckline.
    if (cuff > 0) torsoParts.push(sleeve(-0.205), sleeve(0.205))
    else torsoParts.push(seg(0.115, 0.135, 0.08, 0.28, 12).scale(1, 1, 0.72))
    this.torso = new THREE.Mesh(merged(torsoParts), shirt)
    this.torso.position.y = 1.16
    this.body.add(this.torso)

    // ---- head, with the neck merged in so it tips with the head rather than
    // staying rigid while the skull swivels off it.
    this.head = new THREE.Mesh(
      merged([
        ball(0.115, 0, 0, 0, 1, 1.12, 1.04),
        ball(0.086, -0.055, 0, -0.018, 1, 0.82, 1),   // jaw
        ball(0.018, -0.014, 0, -0.108),               // nose
        ball(0.03, 0.005, -0.112, 0.008, 0.5, 1, 0.85),
        ball(0.03, 0.005, 0.112, 0.008, 0.5, 1, 0.85),
        seg(0.05, 0.058, 0.2, -0.1),                  // neck
      ]),
      skin,
    )
    this.head.position.y = 1.62
    this.body.add(this.head)

    // ---- hair, headwear and face furniture. One vertex-coloured mesh, so a
    // white beard under a red turban over dark brows is still a single draw
    // call. This is where nearly all the crowd variety lives: the body is a
    // body, but you read a person from the head.
    const old = rng.chance(0.22)
    const hairCol = old ? rng.pick(GREY) : rng.pick(HAIR)
    const style = rng.pick(['cap', 'cap', 'cap', 'turban', 'turban', 'bald', 'long'] as const)
    const hairParts: THREE.BufferGeometry[] = [
      // Eyes and brows. Two dots is all it takes for a head to stop reading as
      // an egg; the brows are what give it an expression at any distance.
      tint(ball(0.019, 0.005, -0.045, -0.1, 1, 0.8, 1), 0x140d09),
      tint(ball(0.019, 0.005, 0.045, -0.1, 1, 0.8, 1), 0x140d09),
      tint(ball(0.028, 0.043, -0.047, -0.094, 1.25, 0.4, 0.6), hairCol),
      tint(ball(0.028, 0.043, 0.047, -0.094, 1.25, 0.4, 0.6), hairCol),
    ]

    this.turbaned = style === 'turban'
    if (style === 'turban') {
      // A wrapped band sitting on the brow with a tail down the nape. Reads
      // from further away than any hairstyle does, because it is a different
      // colour from the head rather than a darker version of it.
      const cloth = rng.pick(TURBAN)
      hairParts.push(
        tint(ball(0.133, 0.052, 0, 0.01, 1, 0.66, 1.02), cloth),
        tint(ball(0.115, 0.095, 0, 0.014, 1, 0.55, 1), cloth),
        tint(ball(0.045, -0.03, 0, 0.108, 0.9, 1.5, 0.6), cloth),
      )
    } else if (style === 'bald') {
      // Fringe round the back and sides only — the crown stays skin.
      hairParts.push(tint(ball(0.118, -0.038, 0, 0.042, 1.02, 0.62, 0.95), hairCol))
    } else {
      // Skull cap rather than a slab on top — a hemisphere clipped at the brow.
      // Clipped at 0.42pi, not 0.6pi: past the equator it swallows the ears and
      // the temples and the head stops reading as hair at all, it reads as a
      // motorcycle helmet.
      const cap = new THREE.SphereGeometry(0.126, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.42)
      cap.scale(1, 1.12, 1.04)
      cap.translate(0, 0.008, 0.006)
      hairParts.push(
        tint(cap, hairCol),
        // Occiput. Pushed back far enough to break the skull silhouette but not
        // so far that it reaches the brow: 0.122 - 0.04 = 0.082, comfortably
        // inside the 0.115 head, so nothing surfaces on the face.
        tint(ball(0.122, -0.005, 0, 0.04, 1, 0.94, 1), hairCol),
      )
      // Hair to the nape. Hangs off the back of the head, so it never crosses
      // the face however far the head pitches.
      if (style === 'long') {
        hairParts.push(tint(ball(0.13, -0.06, 0, 0.055, 1, 1.35, 0.85), hairCol))
      }
    }

    // Beards. Centre sits behind and below the nose, so the sphere never
    // reaches the nose tip at z -0.108 — the face stays a face.
    if (rng.chance(0.45)) {
      hairParts.push(tint(ball(0.095, -0.072, 0, -0.018, 1, 0.92, 1), hairCol))
      if (rng.chance(0.6)) hairParts.push(tint(ball(0.042, -0.032, 0, -0.088, 1.5, 0.42, 0.7), hairCol))
    }

    const hair = new THREE.Mesh(
      merged(hairParts),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }),
    )
    // Child of the head, so it follows when the head pitches.
    this.head.add(hair)

    const mkLimb = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number) => {
      const m = new THREE.Mesh(geo, mat)
      m.position.set(x, y, 0)
      this.body.add(m)
      return m
    }

    // Upper arm, elbow, forearm, hand — 0.56 long overall, as the box was.
    const armGeo = () =>
      merged([
        seg(0.058, 0.05, 0.29, 0),
        ball(0.052, -0.29),
        seg(0.05, 0.038, 0.25, -0.29),
        ball(0.05, -0.56, 0, 0, 1, 1.2, 0.72),
      ])
    // Thigh, knee, shin, foot — 0.86 to the sole.
    const legGeo = () => {
      const foot = new THREE.BoxGeometry(0.1, 0.07, 0.21)
      foot.translate(0, -0.83, -0.05)
      return merged([
        seg(0.095, 0.075, 0.46, 0),
        ball(0.076, -0.46),
        seg(0.072, 0.052, 0.4, -0.46),
        foot,
      ])
    }

    // Hung from the shoulder balls at +-0.19, not from the old box's corners at
    // +-0.3 — out there they swung with a hand's width of daylight between arm
    // and body.
    this.armL = mkLimb(armGeo(), skin, -0.205, 1.375)
    this.armR = mkLimb(armGeo(), skin, 0.205, 1.375)
    this.legL = mkLimb(legGeo(), pants, -0.12, 0.86)
    this.legR = mkLimb(legGeo(), pants, 0.12, 0.86)

    // ---- wounds. One merged mesh of flattened blobs sitting a hair proud of
    // the torso and shoulders, hidden until something opens them up. Merged and
    // sharing one material because a villager who has been clawed is still one
    // extra draw call, not six — with twenty of them alive that distinction is
    // the whole frame budget.
    this.woundMat = new THREE.MeshStandardMaterial({ color: 0x4a0509, roughness: 0.35 })
    this.wounds = new THREE.Mesh(
      merged([
        ball(0.075, 1.28, -0.1, -0.13, 1.5, 1.1, 0.5),  // chest, across the ribs
        ball(0.06, 1.38, 0.16, -0.1, 1.1, 1.4, 0.5),    // right shoulder
        ball(0.055, 1.14, -0.19, 0.02, 0.5, 1.6, 1.1),  // left flank
        ball(0.07, 1.2, 0.05, 0.15, 1.4, 1.2, 0.5),     // back
        ball(0.05, 1.55, -0.06, -0.06, 1.2, 0.9, 0.9),  // throat
      ]),
      this.woundMat,
    )
    this.wounds.visible = false
    this.body.add(this.wounds)

    this.body.scale.set(wide, tall, wide)
    this.body.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true
        o.receiveShadow = true
      }
    })
  }

  // ------------------------------------------------------------- spawning
  spawn(kind: HumanKind, pos: THREE.Vector3, waveScale: number) {
    this.kind = kind
    this.pos.copy(pos)
    this.vel.set(0, 0, 0)
    this.alive = true
    this.state = 'wander'
    this.awareness = 0
    this.alerted = false
    this.fearTimer = 0
    this.staggerTimer = 0
    this.deathTimer = 0
    this.hurtFlash = 0
    this.screamed = false
    this.repathTimer = 0
    this.fireTimer = this.rng.range(0.4, 1.6)
    this.aimTimer = 0
    this.yaw = this.rng.range(0, Math.PI * 2)

    const cfg = kind === 'hunter' ? HUMAN.hunter : HUMAN.villager
    this.maxHealth = cfg.health * (1 + waveScale)
    this.health = this.maxHealth

    this.leanX = this.leanZ = 0
    this.bleedTimer = 0
    this.fed = false

    // Recolour so hunters read instantly as the dangerous ones. The pool
    // recycles corpses, so every trace of the last life has to be scrubbed:
    // a slot that came back with someone else's blood still on it was the
    // giveaway that these are the same twenty bodies over and over.
    const shirt = this.mats[1]!
    shirt.color.setHex(kind === 'hunter' ? this.rng.pick(HUNTER_SHIRT) : this.rng.pick(SHIRT))
    shirt.emissive.setHex(0x000000)
    this.mats[0]!.color.setHex(this.rng.pick(SKIN))
    this.wounds.visible = false
    this.woundMat.color.setHex(0x4a0509)

    this.mats[2]!.color.setHex(this.rng.pick(TROUSER))
    this.setRifleVisible(kind === 'hunter')
    this.setKit(kind === 'hunter')
    this.group.visible = true
    this.group.rotation.set(0, this.yaw, 0)
    this.body.rotation.set(0, 0, 0)
    this.body.position.set(0, 0, 0)
    this.armL.rotation.set(0, 0, 0)
    this.armR.rotation.set(0, 0, 0)
    this.legL.rotation.set(0, 0, 0)
    this.legR.rotation.set(0, 0, 0)
    this.head.rotation.set(0, 0, 0)
    this.syncTransform()
  }

  private setRifleVisible(on: boolean) {
    if (on && !this.rifle) {
      const g = new THREE.Group()
      const stock = new THREE.Mesh(
        new THREE.BoxGeometry(0.07, 0.09, 0.5),
        new THREE.MeshStandardMaterial({ color: 0x4a3220, roughness: 0.85 }),
      )
      const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.022, 0.022, 0.72, 6),
        new THREE.MeshStandardMaterial({ color: 0x22242a, roughness: 0.45, metalness: 0.7 }),
      )
      barrel.rotation.x = Math.PI / 2
      barrel.position.z = -0.5
      g.add(stock, barrel)
      // Follows the arm in from 0.3 — the shoulders narrowed when the rig
      // stopped being a box.
      g.position.set(0.22, 1.3, -0.18)
      g.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true })
      this.body.add(g)
      this.rifle = g
    }
    if (this.rifle) this.rifle.visible = on
  }

  /**
   * The hunters' kit — bandolier, belt and slouch hat.
   *
   * Two extra meshes, and only ever on hunters, which the wave table caps at
   * fourteen. Villagers stay at six. That is the trade: the one silhouette in
   * the crowd you have to identify before it shoots you is worth twenty-eight
   * draw calls, and dressing all fifty-two is not.
   *
   * Built lazily and vertex-coloured, so leather, felt and brass share one
   * material. Unlike the rifle this stays on the corpse — the gun is dropped,
   * the webbing is not.
   */
  private setKit(on: boolean) {
    if (on && !this.kitBody) {
      const gear = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72 })

      // Bandolier: over the left shoulder to the right hip, with the return
      // strap round the back so it doesn't read as a stripe painted on.
      const strap = (angle: number, z: number) => {
        const g = new THREE.CylinderGeometry(0.028, 0.028, 0.52, 8)
        g.scale(1, 1, 0.5)
        g.rotateZ(angle)
        g.translate(-0.005, 1.19, z)
        return tint(g, LEATHER)
      }
      const parts: THREE.BufferGeometry[] = [strap(0.72, -0.125), strap(-0.72, 0.115)]
      // Cartridges up the front of the strap, spaced along its axis.
      for (let i = -3; i <= 3; i++) {
        const t = i * 0.062
        const c = new THREE.CylinderGeometry(0.017, 0.017, 0.052, 6)
        c.rotateX(Math.PI / 2)
        c.translate(-0.005 - t * 0.66, 1.19 + t * 0.755, -0.15)
        parts.push(tint(c, BRASS))
      }
      // Belt over the hip wrap, with a pouch on the hip.
      parts.push(tint(band(0.212, 0.06, 0.94, 0.76), LEATHER))
      const pouch = new THREE.BoxGeometry(0.12, 0.11, 0.07)
      pouch.translate(0.135, 0.925, -0.11)
      parts.push(tint(pouch, LEATHER))

      this.kitBody = new THREE.Mesh(merged(parts), gear)
      this.body.add(this.kitBody)

      // Slouch hat. Brim wide enough to throw the eyes into shadow, which is
      // most of why a hunter reads as a different animal from a villager.
      const brim = new THREE.CylinderGeometry(0.235, 0.215, 0.022, 16)
      brim.translate(0, 0.088, 0.004)
      const crown = new THREE.CylinderGeometry(0.107, 0.133, 0.115, 16)
      crown.translate(0, 0.152, 0.004)
      const dome = ball(0.107, 0.208, 0, 0.004, 1, 0.55, 1)
      if (!this.turbaned) {
        this.kitHat = new THREE.Mesh(
          merged([tint(brim, FELT), tint(crown, FELT), tint(dome, FELT), tint(band(0.136, 0.032, 0.105), LEATHER)]),
          gear,
        )
        this.head.add(this.kitHat)
      }

      for (const m of [this.kitBody, this.kitHat]) {
        if (!m) continue
        m.castShadow = true
        m.receiveShadow = true
      }
    }
    if (this.kitBody) this.kitBody.visible = on
    if (this.kitHat) this.kitHat.visible = on
  }

  private syncTransform() {
    this.group.position.copy(this.pos)
    this.group.rotation.y = this.yaw
  }

  get cfg() {
    return this.kind === 'hunter' ? HUMAN.hunter : HUMAN.villager
  }

  get chestPos(): THREE.Vector3 {
    return new THREE.Vector3(this.pos.x, this.pos.y + 1.2, this.pos.z)
  }

  // --------------------------------------------------------------- damage
  /** Returns true if this hit killed them. */
  hurt(amount: number, from: THREE.Vector3): boolean {
    if (!this.alive) return false
    this.health -= amount
    this.hurtFlash = 1
    this.alerted = true
    this.awareness = 1.4
    this.staggerTimer = Math.max(this.staggerTimer, 0.3)

    // Direction the blow came from, in world space and then in body-local — the
    // rig has to lean and fall away from it, not always forward.
    const dx = this.pos.x - from.x
    const dz = this.pos.z - from.z
    const l = Math.hypot(dx, dz) || 1
    const wx = dx / l
    const wz = dz / l
    const c = Math.cos(-this.yaw)
    const s = Math.sin(-this.yaw)
    this.fallX = wx * c - wz * s
    this.fallZ = wx * s + wz * c
    // Whipped away from the impact hard enough to see, then damped out.
    this.leanX = clamp(this.leanX + this.fallZ * 0.85, -1, 1)
    this.leanZ = clamp(this.leanZ - this.fallX * 0.85, -1, 1)

    // Knocked back, harder the bigger the hit.
    const shove = 3.4 + Math.min(amount, 140) * 0.03
    this.vel.x += wx * shove
    this.vel.z += wz * shove

    // Torn open, and it stays torn: the wound layer surfaces on first blood and
    // spreads as they bleed out, so a half-dead villager looks half-dead.
    this.showWounds()

    if (this.health <= 0) {
      this.die()
      return true
    }
    if (this.kind === 'villager') this.state = 'flee'
    return false
  }

  /**
   * Reveal and grow the wound layer, and soak the clothing. Everything is
   * driven off the health fraction so it is monotonic — the damage only ever
   * gets worse, which is what makes it read as accumulated rather than flashing.
   */
  private showWounds() {
    const gone = clamp(1 - this.health / this.maxHealth, 0, 1)
    this.wounds.visible = true
    // Starts as a couple of gashes, ends as most of the torso.
    this.wounds.scale.setScalar(0.45 + gone * 0.75)
    this.woundMat.color.setHex(0x4a0509).lerp(WET_BLOOD, gone * 0.6)
    // Blood wicks through the shirt from the wound outward.
    this.mats[1]!.color.lerp(SOAKED, gone * 0.35)
    this.mats[0]!.color.lerp(SOAKED, gone * 0.18)
    this.woundPos.set(this.pos.x, this.pos.y + 1.3, this.pos.z)
  }

  private die() {
    this.alive = false
    this.state = 'dead'
    this.deathTimer = 0
    this.vel.set(0, 0, 0)
    this.health = 0
    this.showWounds()
    // Keep pumping for a couple of seconds. The game turns each pulse into a
    // spray, which is what an opened throat looks like and one burst does not.
    this.bleedTimer = HUMAN.bleedDuration
    this.bleedNext = 0
    this.setRifleVisible(false)
  }

  // ---------------------------------------------------------------- feeding
  /** Can the tiger still get something out of this body? */
  get feedable(): boolean {
    return !this.alive && !this.fed && this.group.visible && this.deathTimer > 0.35
  }

  /** Consume the corpse. It collapses further and stops being worth anything. */
  feed() {
    this.fed = true
    // Torn apart: sinks flatter and stops registering on the radar.
    this.deathTimer = Math.max(this.deathTimer, HUMAN.corpseLife * 0.72)
  }

  terrify(duration: number, stagger: number) {
    if (!this.alive) return
    this.fearTimer = Math.max(this.fearTimer, duration)
    this.staggerTimer = Math.max(this.staggerTimer, stagger)
    this.alerted = true
    this.awareness = 1.2
    this.state = 'panic'
  }

  alertTo(_tigerPos: THREE.Vector3) {
    if (!this.alive || this.alerted) return
    this.alerted = true
    this.awareness = Math.max(this.awareness, 1.0)
    this.state = this.kind === 'hunter' ? 'hunt' : 'flee'
  }

  // --------------------------------------------------------------- update
  update(
    dt: number,
    tigerPos: THREE.Vector3,
    tigerVisibility: number,
    tigerNoise: number,
    world: World,
    waveScale: number,
  ) {
    this.pendingShot = null
    this.pendingShout = false
    this.bleedPulse = false
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 3)
    this.mats[1]!.emissive.setRGB(this.hurtFlash * 0.7, 0, 0)
    this.leanX = damp(this.leanX, 0, 7, dt)
    this.leanZ = damp(this.leanZ, 0, 7, dt)

    if (!this.alive) {
      this.updateDeath(dt)
      return
    }

    this.fearTimer = Math.max(0, this.fearTimer - dt)
    this.staggerTimer = Math.max(0, this.staggerTimer - dt)

    this.updatePerception(dt, tigerPos, tigerVisibility, tigerNoise, world)
    this.updateBrain(dt, tigerPos, world, waveScale)
    this.updateMotion(dt, world)
    this.animate(dt)
    this.syncTransform()
  }

  private updatePerception(
    dt: number,
    tigerPos: THREE.Vector3,
    visibility: number,
    noise: number,
    world: World,
  ) {
    const cfg = this.cfg
    const dx = tigerPos.x - this.pos.x
    const dz = tigerPos.z - this.pos.z
    const dist = Math.hypot(dx, dz)

    let gain = 0

    // Hearing: loud movement gives you away regardless of cover.
    if (dist < noise) gain += (1 - dist / noise) * 1.4

    // Sight: needs range, facing, line of sight, and the tiger not concealed.
    if (dist < cfg.sightRange * visibility + 3) {
      const fx = -Math.sin(this.yaw)
      const fz = -Math.cos(this.yaw)
      const dot = (dx * fx + dz * fz) / (dist || 1)
      const inFov = Math.acos(clamp(dot, -1, 1)) < cfg.sightFov
      if (inFov && !world.losBlocked(this.pos.x, this.pos.z, tigerPos.x, tigerPos.z)) {
        const closeness = 1 - dist / (cfg.sightRange || 1)
        gain += closeness * 2.6 * visibility
      }
    }

    if (gain > 0) {
      this.awareness = Math.min(1.6, this.awareness + (gain * dt) / HUMAN.alertTime)
    } else {
      this.awareness = Math.max(0, this.awareness - dt * 0.35)
      if (this.awareness <= 0.05) this.alerted = false
    }

    if (this.awareness >= 1 && !this.alerted) {
      this.alerted = true
      this.pendingShout = true
      if (!this.screamed) this.screamed = true
    }
  }

  private updateBrain(dt: number, tigerPos: THREE.Vector3, world: World, waveScale: number) {
    const cfg = this.cfg
    const dist = Math.hypot(tigerPos.x - this.pos.x, tigerPos.z - this.pos.z)
    this.repathTimer -= dt

    if (this.fearTimer > 0) this.state = 'panic'
    else if (this.alerted) this.state = this.kind === 'hunter' ? 'hunt' : 'flee'
    else if (this.awareness > 0.35) this.state = 'suspicious'
    else if (this.state !== 'wander') this.state = 'wander'

    switch (this.state) {
      case 'wander': {
        if (this.repathTimer <= 0) {
          this.repathTimer = this.rng.range(2.5, 6)
          this.target.copy(world.randomOpenPoint(4, 74, this.rng))
        }
        this.moveToward(this.target, cfg.wanderSpeed, dt)
        break
      }

      case 'suspicious': {
        // Stop, turn toward the noise, scan.
        this.vel.x = damp(this.vel.x, 0, 6, dt)
        this.vel.z = damp(this.vel.z, 0, 6, dt)
        this.faceToward(tigerPos, dt, 3.5)
        break
      }

      case 'flee': {
        // Run away from the tiger, biased toward firelight (villagers feel safe there).
        if (this.repathTimer <= 0) {
          this.repathTimer = 0.7
          const away = new THREE.Vector3(this.pos.x - tigerPos.x, 0, this.pos.z - tigerPos.z)
          if (away.lengthSq() < 0.01) away.set(1, 0, 0)
          away.normalize().multiplyScalar(22)
          let dest = new THREE.Vector3(this.pos.x + away.x, 0, this.pos.z + away.z)
          let bestFire: THREE.Vector3 | null = null
          let bestScore = -Infinity
          for (const f of world.campfires) {
            const dFire = Math.hypot(f.x - this.pos.x, f.z - this.pos.z)
            const fireFromTiger = Math.hypot(f.x - tigerPos.x, f.z - tigerPos.z)
            const score = fireFromTiger - dFire * 0.6
            if (score > bestScore) { bestScore = score; bestFire = f }
          }
          if (bestFire && bestScore > 8) dest = dest.lerp(bestFire, 0.55)
          this.target.set(dest.x, 0, dest.z)
        }
        this.moveToward(this.target, HUMAN.villager.fleeSpeed, dt)
        // Look back over the shoulder at what's chasing them.
        if (dist < 14) this.faceAwayFrom(tigerPos, dt, 7)
        break
      }

      case 'hunt': {
        const h = HUMAN.hunter
        this.faceToward(tigerPos, dt, 4.5)
        // Hold at a firing stand-off; close in if the tiger breaks away.
        const ideal = h.fireRange * 0.6
        if (dist > h.fireRange * 0.95) {
          this.moveToward(tigerPos, h.chaseSpeed, dt)
        } else if (dist < ideal * 0.5) {
          // Back off, keep the rifle useful.
          const away = new THREE.Vector3(this.pos.x - tigerPos.x, 0, this.pos.z - tigerPos.z).normalize()
          this.target.set(this.pos.x + away.x * 8, 0, this.pos.z + away.z * 8)
          this.moveToward(this.target, h.chaseSpeed * 0.8, dt)
        } else {
          this.vel.x = damp(this.vel.x, 0, 8, dt)
          this.vel.z = damp(this.vel.z, 0, 8, dt)
        }

        this.fireTimer -= dt
        const clear = !world.losBlocked(this.pos.x, this.pos.z, tigerPos.x, tigerPos.z)
        if (dist < h.fireRange && clear && this.staggerTimer <= 0) {
          this.aimTimer += dt
          if (this.fireTimer <= 0 && this.aimTimer >= h.aimTime) {
            this.fireTimer = h.fireInterval * this.rng.range(0.8, 1.25)
            this.aimTimer = 0
            this.fire(tigerPos, dist, waveScale)
          }
        } else {
          this.aimTimer = Math.max(0, this.aimTimer - dt * 2)
        }
        break
      }

      case 'panic': {
        // Blind terror: sprint in a wobbling line away from the tiger.
        if (this.repathTimer <= 0) {
          this.repathTimer = 0.45
          const a = Math.atan2(this.pos.z - tigerPos.z, this.pos.x - tigerPos.x) + this.rng.range(-0.9, 0.9)
          this.target.set(this.pos.x + Math.cos(a) * 18, 0, this.pos.z + Math.sin(a) * 18)
        }
        const panicSpeed = (this.kind === 'hunter' ? HUMAN.hunter.chaseSpeed : HUMAN.villager.fleeSpeed) * 1.12
        this.moveToward(this.target, this.staggerTimer > 0 ? 0.4 : panicSpeed, dt)
        break
      }

      default:
        break
    }
  }

  private fire(tigerPos: THREE.Vector3, dist: number, waveScale: number) {
    const h = HUMAN.hunter
    const origin = new THREE.Vector3(this.pos.x, this.pos.y + HUMAN.eyeHeight, this.pos.z)
    const dir = new THREE.Vector3(
      tigerPos.x - origin.x,
      tigerPos.y + 1.2 - origin.y,
      tigerPos.z - origin.z,
    ).normalize()

    // Aim error grows with range; a sprinting tiger is a harder target.
    const spread = h.spread * (1 + dist / h.fireRange)
    const miss = this.rng.next() < clamp(spread * 6, 0.08, 0.6)
    if (miss) {
      dir.x += this.rng.range(-spread, spread) * 5
      dir.y += this.rng.range(-spread, spread) * 3
      dir.z += this.rng.range(-spread, spread) * 5
      dir.normalize()
    }
    this.pendingShot = {
      origin,
      dir,
      damage: h.damage * (1 + waveScale),
      hit: !miss,
    }
    // Recoil kick on the rifle arm.
    this.staggerTimer = Math.max(this.staggerTimer, 0.12)
  }

  private moveToward(dest: THREE.Vector3, speed: number, dt: number) {
    if (this.staggerTimer > 0) speed *= 0.25
    const dx = dest.x - this.pos.x
    const dz = dest.z - this.pos.z
    const d = Math.hypot(dx, dz)
    if (d < 0.4) {
      this.vel.x = damp(this.vel.x, 0, 8, dt)
      this.vel.z = damp(this.vel.z, 0, 8, dt)
      return
    }
    const wantX = (dx / d) * speed
    const wantZ = (dz / d) * speed
    this.vel.x = damp(this.vel.x, wantX, 8, dt)
    this.vel.z = damp(this.vel.z, wantZ, 8, dt)
    if (this.state !== 'hunt') {
      const targetYaw = Math.atan2(-this.vel.x, -this.vel.z)
      this.yaw = angleDamp(this.yaw, targetYaw, 8, dt)
    }
  }

  private faceToward(p: THREE.Vector3, dt: number, rate: number) {
    const targetYaw = Math.atan2(-(p.x - this.pos.x), -(p.z - this.pos.z))
    this.yaw = angleDamp(this.yaw, targetYaw, rate, dt)
  }
  private faceAwayFrom(p: THREE.Vector3, dt: number, rate: number) {
    const targetYaw = Math.atan2(p.x - this.pos.x, p.z - this.pos.z)
    this.yaw = angleDamp(this.yaw, targetYaw, rate, dt)
  }

  private updateMotion(dt: number, world: World) {
    this.pos.x += this.vel.x * dt
    this.pos.z += this.vel.z * dt
    const r = world.resolve(this.pos.x, this.pos.z, HUMAN.radius, this.pos.y + 1)
    this.pos.x = r.x
    this.pos.z = r.z
    if (r.hit) {
      // Bumped a wall — repath next tick instead of grinding against it.
      this.repathTimer = Math.min(this.repathTimer, 0.15)
    }
    this.pos.y = terrainHeight(this.pos.x, this.pos.z)
  }

  private animate(dt: number) {
    const speed = Math.hypot(this.vel.x, this.vel.z)
    this.stepPhase += dt * (3.2 + speed * 1.5)
    const amp = clamp(speed / 5, 0, 1) * 0.9

    this.legL.rotation.x = Math.sin(this.stepPhase) * amp
    this.legR.rotation.x = Math.sin(this.stepPhase + Math.PI) * amp

    if (this.kind === 'hunter' && (this.state === 'hunt' || this.aimTimer > 0.1)) {
      // Shouldered rifle pose. Positive rotation.x, not negative: the body
      // faces local -Z (see the sight vector in `sense`), and a limb hanging
      // down lands at z = -sin(x), so a negative angle throws the arms out
      // behind the back while the rifle stays out front.
      this.armR.rotation.x = 1.45
      this.armR.rotation.z = -0.1
      this.armL.rotation.x = 1.25
      this.armL.rotation.z = 0.35
      if (this.rifle) {
        this.rifle.rotation.set(-0.05, 0, 0)
        this.rifle.position.set(0.16, 1.42, -0.3)
      }
    } else {
      this.armL.rotation.x = Math.sin(this.stepPhase + Math.PI) * amp * 0.85
      this.armR.rotation.x = Math.sin(this.stepPhase) * amp * 0.85
      // Both cleared, not just the left: the pool recycles a dead hunter into a
      // villager, and a stale z leaves one arm cocked out for the rest of the run.
      this.armL.rotation.z = 0
      this.armR.rotation.z = 0
      if (this.rifle) {
        // Slung across the back, muzzle above the left shoulder. The old idle
        // parked it at the ribs with both arms hanging slack, so it read as a
        // stick skewering the chest. Carrying it in the hands isn't an option
        // either: the arms are single rigid meshes with no elbow, so a hand can
        // only ever sit 0.56 m dead in line with the shoulder and never lands
        // on the grip. A sling needs no hands, leaves the walk swing alone, and
        // the barrel over the shoulder still says "armed" from the front.
        this.rifle.rotation.set(1.25, 0.6, 0)
        this.rifle.position.set(0.05, 1.15, 0.17)
      }
    }

    // Arms up and flailing when terrified.
    if (this.state === 'panic' || (this.state === 'flee' && speed > 3)) {
      this.armL.rotation.x = 2.4 + Math.sin(this.stepPhase * 2.2) * 0.45
      this.armR.rotation.x = 2.4 + Math.sin(this.stepPhase * 2.2 + 1.7) * 0.45
      this.armL.rotation.z = 0.4
      this.armR.rotation.z = -0.4
    }

    // Lean into the run, plus whatever the last blow did. The lean is applied
    // to the whole body rather than the torso so the legs buckle with it — a
    // struck man folds, he doesn't bow politely from the waist.
    this.torso.rotation.x = damp(this.torso.rotation.x, clamp(speed / 14, 0, 0.3), 6, dt)
    this.head.rotation.x = -this.torso.rotation.x
    this.body.rotation.x = this.leanX * 0.5
    this.body.rotation.z = this.leanZ * 0.5
    // Clutching the wound while they run.
    const hurtAmt = clamp(1 - this.health / this.maxHealth, 0, 1)
    if (hurtAmt > 0.25 && this.state !== 'hunt') {
      this.armR.rotation.x += hurtAmt * 1.5
      this.armR.rotation.z = -hurtAmt * 0.7
    }
  }

  private updateDeath(dt: number) {
    this.deathTimer += dt

    // Arterial pulses for the first couple of seconds. The game reads the flag
    // and sprays from woundPos; this only decides when.
    if (this.bleedTimer > 0) {
      this.bleedTimer -= dt
      this.bleedNext -= dt
      if (this.bleedNext <= 0) {
        this.bleedNext = HUMAN.bleedInterval
        this.bleedPulse = true
        this.woundPos.set(this.pos.x, this.pos.y + 0.9 - (1 - this.bleedTimer / HUMAN.bleedDuration) * 0.6, this.pos.z)
      }
    }

    // Topple away from whatever hit them, over the first half-second, with a
    // bounce at the bottom rather than settling dead flat — a body dropping on
    // its face and a body flung onto its back are different deaths, and always
    // playing the first one was most of why kills felt weightless.
    const fall = clamp(this.deathTimer / 0.55, 0, 1)
    const eased = fall * fall * (3 - 2 * fall)
    const settle = fall >= 1 ? 0 : Math.sin(fall * Math.PI * 2) * 0.09 * (1 - fall)
    const tip = (Math.PI / 2) * 0.96 * (eased + settle)
    this.body.rotation.x = -this.fallZ * tip
    this.body.rotation.z = this.fallX * tip
    this.body.position.y = -eased * 0.12

    // Limbs go slack and splay, rather than staying mid-stride.
    const slack = 1 - eased
    this.legL.rotation.x = damp(this.legL.rotation.x, 0.22, 6, dt) * (0.3 + slack * 0.7)
    this.legR.rotation.x = damp(this.legR.rotation.x, -0.15, 6, dt) * (0.3 + slack * 0.7)
    this.legL.rotation.z = damp(this.legL.rotation.z, 0.2, 5, dt)
    this.legR.rotation.z = damp(this.legR.rotation.z, -0.28, 5, dt)
    this.armL.rotation.x = damp(this.armL.rotation.x, 0.5, 5, dt)
    this.armR.rotation.x = damp(this.armR.rotation.x, 0.85, 5, dt)
    this.armL.rotation.z = damp(this.armL.rotation.z, 0.9, 5, dt)
    this.armR.rotation.z = damp(this.armR.rotation.z, -1.1, 5, dt)
    // Head lolls.
    this.head.rotation.z = damp(this.head.rotation.z, this.fallX * 0.55, 4, dt)
    this.torso.rotation.x = damp(this.torso.rotation.x, 0, 5, dt)

    // Lie *on* the ground, not standing upright through a slope. Two height
    // samples give the gradient; the corpse pitches and rolls onto it.
    const gx = terrainHeight(this.pos.x + 0.6, this.pos.z) - terrainHeight(this.pos.x - 0.6, this.pos.z)
    const gz = terrainHeight(this.pos.x, this.pos.z + 0.6) - terrainHeight(this.pos.x, this.pos.z - 0.6)
    this.group.rotation.set(clamp(gz / 1.2, -0.5, 0.5) * eased, this.yaw, -clamp(gx / 1.2, -0.5, 0.5) * eased, 'YXZ')

    if (this.deathTimer > HUMAN.corpseLife) {
      const sink = (this.deathTimer - HUMAN.corpseLife) / 2
      this.group.position.y = this.pos.y - sink * 2.2
      if (sink >= 1) this.group.visible = false
    } else {
      this.group.position.copy(this.pos)
    }
  }

  /** True once the corpse has fully sunk and the slot can be reused. */
  get expired(): boolean {
    return !this.alive && this.deathTimer > HUMAN.corpseLife + 2
  }
}

function angleDamp(a: number, b: number, lambda: number, dt: number): number {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI
  if (diff < -Math.PI) diff += Math.PI * 2
  return a + diff * (1 - Math.exp(-lambda * dt))
}
