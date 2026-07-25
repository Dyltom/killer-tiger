/**
 * Every tunable number in the game. No magic numbers in gameplay code.
 * Units: metres, seconds, radians.
 */

export const WORLD = {
  /** Half-extent of the playable square. Terrain is 2x this. */
  radius: 130,
  /** Invisible wall the tiger cannot cross (kept inside terrain edge). */
  bounds: 122,
  groundY: 0,
  fogNear: 40,
  fogFar: 210,
  /** How many grass patches (stalking cover) to scatter. */
  grassPatches: 220,
  trees: 130,
  rocks: 45,
  huts: 22,
  campfires: 5,
}

export const TIGER = {
  eyeHeight: 1.55,
  crouchEyeHeight: 0.85,
  radius: 0.75,

  walkSpeed: 6.2,
  sprintSpeed: 13.5,
  crouchSpeed: 3.0,
  /** Ground acceleration / friction (higher = snappier). */
  accel: 42,
  friction: 11,
  airControl: 0.28,

  gravity: 26,
  /** Straight-up hop when pouncing with no forward input. */
  pounceUp: 8.4,
  /** Forward burst added along the look direction. */
  pounceForward: 15.5,
  pounceCost: 24,

  maxHealth: 100,
  healthRegen: 1.6, // per second, after regenDelay of no damage
  regenDelay: 6.0,

  maxStamina: 100,
  sprintDrain: 22,
  staminaRegen: 17,
  staminaRegenDelay: 0.7,

  maxRage: 100,
  rageDecay: 1.4, // per second when out of combat

  /** Claw swipe. */
  clawRange: 3.6,
  clawArc: 0.62, // cos-threshold half-angle in radians
  clawDamage: 46,
  clawCooldown: 0.42,

  /** Killing bite: shorter range, huge damage, heals on kill. */
  biteRange: 2.9,
  biteArc: 0.42,
  biteDamage: 130,
  biteCooldown: 0.85,
  biteHeal: 18,

  roarRadius: 26,
  roarCooldown: 9.0,
  roarFearDuration: 5.5,
  roarStagger: 1.4,

  frenzyDuration: 9.0,
  frenzyDamageMult: 2.2,
  frenzySpeedMult: 1.32,

  /** Detection: how loud the tiger is, scaled by movement state. */
  noiseSprint: 26,
  noiseWalk: 14,
  noiseCrouch: 5,
  /** Vision radius multiplier while crouched in grass. */
  grassConcealment: 0.35,
}

export const HUMAN = {
  radius: 0.42,
  height: 1.8,
  eyeHeight: 1.62,

  villager: {
    health: 60,
    wanderSpeed: 1.6,
    fleeSpeed: 6.4,
    sightRange: 30,
    sightFov: 1.15, // half-angle radians
    score: 100,
    rage: 14,
  },
  hunter: {
    health: 110,
    wanderSpeed: 2.4,
    chaseSpeed: 4.6,
    sightRange: 46,
    sightFov: 1.0,
    score: 250,
    rage: 26,
    /** Ranged attack. */
    fireRange: 34,
    fireInterval: 1.9,
    aimTime: 0.7,
    damage: 13,
    /** Random aim error in radians; grows with tiger speed. */
    spread: 0.055,
  },
  /** Seconds of continuous sight before a human is certain and alerts others. */
  alertTime: 0.55,
  alertShoutRadius: 34,
  /** Corpse lingers this long, then sinks. */
  corpseLife: 14,
}

export const WAVE = {
  /** Prey required in hunt N = base + step * (N-1). */
  basePrey: 6,
  preyStep: 3,
  /** Villagers alive at once. */
  villagerBase: 9,
  villagerStep: 2,
  villagerMax: 26,
  /** Hunters alive at once. */
  hunterBase: 1,
  hunterStep: 1.15,
  hunterMax: 14,
  /** Between-hunt breather. */
  interWaveDelay: 4.0,
  /** Enemy stat scaling per hunt. */
  healthScale: 0.07,
  damageScale: 0.05,
}

export const COMBO = {
  /** Kill within this window extends the chain. */
  window: 4.5,
  /** Score multiplier = 1 + (chain-1) * step, capped. */
  step: 0.35,
  max: 5.0,
}

export const PICKUP = {
  spawnInterval: 9.0,
  maxAlive: 7,
  bobSpeed: 2.2,
  bobHeight: 0.22,
  spinSpeed: 1.4,
  grabRadius: 2.1,
  lifetime: 45,
}

export const BUFFS = {
  adrenaline: { duration: 14, speedMult: 1.35, label: 'Adrenaline' },
  ironClaws: { duration: 16, damageMult: 1.8, label: 'Iron Claws' },
  ironHide: { duration: 14, damageTaken: 0.4, label: 'Iron Hide' },
  bloodScent: { duration: 20, label: 'Blood Scent' },
}

export const CAMERA = {
  fov: 78,
  sprintFov: 88,
  frenzyFov: 94,
  near: 0.1,
  far: 420,
  /** Mouse sensitivity, radians per pixel. */
  sensitivity: 0.0022,
  pitchLimit: 1.45,
  /** Head bob. */
  bobFreq: 9.2,
  bobAmp: 0.075,
  swayAmp: 0.05,
}

export const COLORS = {
  fog: 0x4b5544,
  skyTop: 0x1b2a3d,
  skyBottom: 0xd98a4a,
  sun: 0xffd9a0,
  ambient: 0x4a5560,
  grass: 0x4a5c33,
  dirt: 0x6b5539,
  blood: 0x8e0f14,
}

export const STORAGE_KEY = 'killer-tiger:best'
