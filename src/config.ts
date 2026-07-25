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
  /** Blades per stalking patch — these are the tall ones you hide in. */
  bladesPerPatch: 88,
  /**
   * Short filler grass scattered everywhere so the ground is never bare.
   * Spread over a 120 m disc this is ~1 tuft/m2; much below that and the
   * ground reads as bare dirt with weeds dotted on it.
   */
  groundCover: 155000,
  trees: 130,
  /** Low scrub between the trees — the midground layer that hides the horizon. */
  bushes: 300,
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

/**
 * Atmosphere. The sun sits just above the horizon and behind the village, so
 * the player stalks in toward the light and everything they hunt is rimmed by
 * it. Elevation below about 1.5 degrees makes the Preetham model collapse to
 * near-black, so this is as low as the sun can usefully go.
 */
export const SKY = {
  // Late golden hour rather than dead-on sunset. At 2-3 degrees everything
  // downsun is a pure silhouette; ~10 degrees still rakes long shadows across
  // the plain but leaves enough front light to read thatch, fur and faces.
  sunElevation: 10.5, // degrees above the horizon
  sunAzimuth: 168, // degrees; the village sits between the tiger and the sun
  // High turbidity plus a 10-degree sun gives a milky grey dome. Dropping it
  // lets the Rayleigh blue back into the zenith while the Mie lobe keeps the
  // gold concentrated around the sun, which is what reads as golden hour.
  turbidity: 3.2,
  rayleigh: 3.0,
  mieCoefficient: 0.006,
  mieDirectionalG: 0.86,
  /**
   * Scales the dome's radiance. Preetham is physically normalised, not
   * art-directed: at this sun elevation the horizon band comes out tens of
   * units of linear white, which swamps the tone map and leaves the whole
   * frame milky. This is the exposure knob for the sky alone, so the ground
   * can stay lit while the sky sits in a sane range.
   */
  domeIntensity: 0.42,
  /** Sky dome radius. Rides with the camera, so it only has to clear the props. */
  radius: 4000,
  /** Cloud dome drift, radians/second. */
  cloudDrift: 0.0035,
  /** Directional (sun) light. */
  sunLight: 0xffd0a0,
  sunIntensity: 3.3,
  /** Sky/ground hemisphere bounce. */
  skyBounce: 0x6f90bd,
  groundBounce: 0x6a5a38,
  bounceIntensity: 1.15,
  /** Image-based lighting from the sky dome. */
  envIntensity: 2.4,
}

/**
 * Height-attenuated, view-direction-tinted fog. Baked into the shader as
 * constants — see render/atmosphere.ts.
 */
export const FOG = {
  // Tuned so a hut at 40 m still shows its thatch texture (~15% fogged) and
  // only the far treeline dissolves. Anything above ~0.01 turns the midground
  // into flat orange cut-outs.
  density: 0.0055,
  /** Larger = fog hugs the ground more tightly. */
  heightFalloff: 0.075,
  /** Colour looking straight into the sun... */
  sunColor: 0xffc286,
  /** ...and looking away from it. */
  awayColor: 0x8fa2ba,
  /** Distance at which fog is fully saturated regardless of height. */
  maxDistance: 300,
  /** How much of the far-plane haze floor to apply (0..1). */
  farFloor: 0.75,
}

/** Post-processing chain. See render/postfx.ts. */
export const POST = {
  exposure: 1.0,
  // Threshold is in linear HDR and the pre-bloom clamp is 3.5, so 2.6 means
  // "only the sun's core and the campfire flames bloom". Wider than this and
  // the whole sky-facing half of the frame turns to milk — the sky near a low
  // sun is a very large area of very bright pixels.
  bloomStrength: 0.06,
  bloomRadius: 0.35,
  bloomThreshold: 2.6,
  /** Screen-space god rays from the sun. The pass returns an average shaft
   *  brightness in the 0..4 range, so this is close to a direct multiplier. */
  godrayStrength: 0.22,
  godrayDecay: 0.955,
  // 48 taps cost a full-screen dependent-texture-read pass per tap and are
  // indistinguishable from 28 once the decay curve is this steep.
  godraySamples: 28,
  /** Final grade. */
  vignette: 0.42,
  grain: 0.032,
  // Kept low. The viewmodel paws sit in the screen corners where lateral
  // chromatic aberration is strongest, and above ~0.0012 their silhouettes
  // pick up visible red/cyan fringes.
  chromatic: 0.001,
  saturation: 1.12,
  contrast: 1.06,
  /** Split-tone: cool shadows, warm highlights. */
  shadowTint: 0x2c3a52,
  highlightTint: 0xffd7a8,
  toneStrength: 0.16,
  sharpen: 0.28,
}

export const STORAGE_KEY = 'killer-tiger:best'
