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
  /**
   * Eye height of a big cat on all fours, not of a man. A Bengal tiger stands
   * about 1.1 m at the shoulder and carries its head level with or just below
   * that when stalking, so the grass comes up past your chin and the huts loom.
   * That low, close-to-the-ground read is most of what sells being an animal.
   */
  eyeHeight: 1.10,
  crouchEyeHeight: 0.55,
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

  /**
   * Impact. A swipe that passes through a body and changes nothing reads as
   * the paw floating in front of the camera rather than hitting anything, so a
   * connecting blow briefly stalls its own animation and jolts the view — the
   * same hit-stop every melee game uses to sell contact.
   */
  hitStop: 0.075,
  killStop: 0.12,
  hitJolt: 0.055,
  /** Seconds of blood on the claws after a hit, and after a kill. */
  clawBloodTime: 7,

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
  corpseLife: 30,
  /**
   * A kill keeps bleeding for a moment after it drops. Two or three visible
   * pulses is the difference between "the body fell over" and "you opened an
   * artery" — one instant burst reads as a puff of red confetti.
   */
  bleedDuration: 2.6,
  bleedInterval: 0.34,
  /** Feeding on a body you dropped. This is the main way back to full health. */
  feedRadius: 2.4,
  feedTime: 1.1,
  feedHeal: 34,
  feedRage: 22,
  feedScore: 60,
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

/**
 * One beat per hunt, so the night has a shape rather than just a rising enemy
 * count. Indexed from hunt 1; past the end of the table the last line repeats,
 * which is the point it has become a siege and stops being a story.
 */
export const STORY: { title: string; line: string; toast: string }[] = [
  { title: 'FIRST BLOOD', line: 'Nobody is awake. Keep it that way', toast: 'The village does not know yet' },
  { title: 'THE ALARM', line: 'A boy saw you. He is running for the headman', toast: 'They have found the first body' },
  { title: 'THE RIFLES', line: 'The old guns are out of their oilcloth', toast: 'Lamps are lit in every doorway' },
  { title: 'THE CORDON', line: 'They are working in pairs now, sweeping the grass', toast: 'They have stopped calling for you and started looking' },
  { title: 'THE FENCE LINE', line: 'This is the ground your mate died on', toast: 'You know this stretch of wire' },
  { title: 'THE BOUNTY', line: 'Word reached the district. Men came for the skin', toast: 'These ones are not farmers' },
  { title: 'THE BURNING', line: 'They are firing the cane to drive you out', toast: 'Smoke on three sides' },
  { title: 'THE LAST NIGHT', line: 'Nine hundred nights of patience, spent', toast: 'There is nothing left to go back to' },
]

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
  /**
   * The bound. A quadruped at speed is airborne once per stride and lands on
   * its forelegs, so the vertical is a rectified arc with a hard bottom rather
   * than the symmetric sine a biped's head traces. `boundPitch` is the nose
   * dropping as the forepaws take the landing.
   */
  boundAmp: 0.20,
  boundPitch: 0.055,
  boundRoll: 0.022,
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
  /**
   * Cloud drift. The dome shader multiplies this by time and adds it to a UV
   * that has already been scaled up by 1000 for the fbm lookup, so 0.0035 moved
   * the cloud field 3.5 noise cells a second — the whole sky boiling. At 1.2e-5
   * a cloud takes about a minute and a half to cross its own width.
   */
  cloudDrift: 0.000012,
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
 * The day. One full rotation takes `period` seconds; `start` is where a hunt
 * begins, expressed as a fraction of that rotation (0 = sunrise, 0.25 = noon,
 * 0.5 = sunset, 0.75 = midnight).
 *
 * `phases` is the palette. Everything the time of day touches — sky model,
 * sun colour and strength, bounce, IBL, haze and exposure — is keyframed here
 * and interpolated, so adding a new mood means adding a row rather than
 * threading another value through four files.
 */
export const DAY = {
  period: 720,
  /** Late golden hour: the hunt opens on the light the game was designed for. */
  start: 0.472,
  /** Peak sun elevation in degrees; elevation follows sin(2*pi*t) times this. */
  maxElevation: 62,
  /**
   * Preetham's sun-intensity term hits exactly zero at a 92.3-degree zenith
   * angle, so anything below about -2.3 degrees renders a pure black dome, not
   * a dark one. Holding the dome's sun at -1 degree leaves roughly 1.5% of
   * daylight radiance — a deep navy with a faintly lit horizon, which is what a
   * moonlit sky actually looks like. The true sun keeps going down; only the
   * dome's copy is clamped.
   */
  domeMinElevation: -1,
  /** Elevation at which the key light hands over from sun to moon. */
  moonHandoff: -1.5,
  /** Re-bake the IBL when the sun has moved this many degrees. */
  envStepDegrees: 4,

  /**
   * Preetham has nothing to say about a sky lit only by moonlight, so below the
   * horizon its zenith collapses to black and the night reads as a rendering
   * fault rather than as night. These two colours are added on top of the dome,
   * faded in by the same `stars` ramp, to give the sky a floor.
   */
  nightZenith: 0x0a1230,
  nightHorizon: 0x22355e,
  /** Moon disc size in pixels at 1x pixel ratio, and its halo multiplier. */
  moonSize: 34,
  moonGlow: 4.5,

  phases: [
    // t      turbidity rayleigh  mie    dome   sun       sunI  skyBounce gndBounce bounceI env   fogSun    fogAway   density  stars exposure
    { t: 0.000, turbidity: 4.2, rayleigh: 3.4, mie: 0.010, dome: 0.55, sun: 0xffb070, sunI: 1.4,  skyB: 0x9fb6d8, gndB: 0x6a5a38, bounceI: 0.85, env: 1.6, fogSun: 0xffb98a, fogAway: 0x9aa9bd, density: 0.0075, stars: 0.25, exposure: 1.00 },
    { t: 0.120, turbidity: 2.6, rayleigh: 2.2, mie: 0.005, dome: 0.34, sun: 0xfff0d8, sunI: 3.6,  skyB: 0x8fb4e6, gndB: 0x7a6a48, bounceI: 1.00, env: 2.2, fogSun: 0xdfe6f0, fogAway: 0xa8bcd6, density: 0.0040, stars: 0.00, exposure: 0.95 },
    { t: 0.250, turbidity: 2.2, rayleigh: 1.6, mie: 0.004, dome: 0.30, sun: 0xfffaf0, sunI: 4.2,  skyB: 0x9cc4ff, gndB: 0x8a7a58, bounceI: 1.05, env: 2.4, fogSun: 0xe8eef6, fogAway: 0xb4c6dc, density: 0.0032, stars: 0.00, exposure: 0.92 },
    { t: 0.400, turbidity: 2.8, rayleigh: 2.4, mie: 0.005, dome: 0.36, sun: 0xffe6c0, sunI: 3.8,  skyB: 0x8fb0dd, gndB: 0x7d6a44, bounceI: 1.05, env: 2.3, fogSun: 0xffd7a8, fogAway: 0xa3b4cc, density: 0.0042, stars: 0.00, exposure: 0.96 },
    { t: 0.472, turbidity: 3.2, rayleigh: 3.0, mie: 0.006, dome: 0.42, sun: 0xffd0a0, sunI: 3.3,  skyB: 0x6f90bd, gndB: 0x6a5a38, bounceI: 1.15, env: 2.4, fogSun: 0xffc286, fogAway: 0x8fa2ba, density: 0.0055, stars: 0.05, exposure: 1.00 },
    { t: 0.520, turbidity: 4.6, rayleigh: 4.0, mie: 0.011, dome: 0.46, sun: 0xff8b46, sunI: 1.5,  skyB: 0x50648c, gndB: 0x50432c, bounceI: 1.20, env: 2.1, fogSun: 0xff9a5a, fogAway: 0x6d7e9c, density: 0.0075, stars: 0.30, exposure: 1.05 },
    // Night is lit by a moon, not by nothing. Real moonlight is about a
    // millionth of daylight, which on screen is an unplayable black frame — so
    // the night rows are a stylised moonlit blue: bright enough to read the
    // terrain and the prey, cold and low-contrast enough to still feel like
    // night. The exposure lift and the desaturated key light do most of it.
    { t: 0.580, turbidity: 5.4, rayleigh: 4.6, mie: 0.008, dome: 1.10, sun: 0xa8c0f0, sunI: 1.90, skyB: 0x54739f, gndB: 0x35342e, bounceI: 2.20, env: 2.4, fogSun: 0x6f7fa8, fogAway: 0x3f4b68, density: 0.0080, stars: 0.85, exposure: 1.15 },
    { t: 0.750, turbidity: 6.0, rayleigh: 3.0, mie: 0.004, dome: 1.40, sun: 0xc2d4ff, sunI: 2.60, skyB: 0x5878b0, gndB: 0x333844, bounceI: 2.40, env: 2.6, fogSun: 0x7f9ad4, fogAway: 0x2c3a58, density: 0.0075, stars: 1.00, exposure: 1.25 },
    { t: 0.920, turbidity: 5.0, rayleigh: 4.2, mie: 0.006, dome: 1.15, sun: 0xb6c8ec, sunI: 2.00, skyB: 0x56749f, gndB: 0x36342e, bounceI: 2.20, env: 2.4, fogSun: 0x7d8cb4, fogAway: 0x45526e, density: 0.0085, stars: 0.70, exposure: 1.15 },
  ],
}

export type DayPhase = (typeof DAY.phases)[number]

/**
 * Height-attenuated, view-direction-tinted fog. The colours and density here
 * are only the starting point — DAY drives them at runtime through the shared
 * uniforms in render/atmosphere.ts.
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
