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
  /**
   * Forefoot strides per second at walkSpeed. Cadence scales as speed^0.7 from
   * here, so a sprint is a longer stride as well as a quicker one — scaling it
   * linearly makes a fast animal look like a wound-up toy.
   */
  strideRate: 1.5,
  swayAmp: 0.05,
  /**
   * The bound, as amplitudes of a plain sinusoid of the gait phase — the head is
   * lowest just after a forefoot plants, highest through the swing, and the nose
   * pitches down into the landing.
   *
   * These are half the old values because the old curve was rectified
   * (`pow(max(sin, 0), 0.6)`) and so only ever moved the head one way from rest.
   * A symmetric sine of the same amplitude travels twice as far. It is also
   * multiplied by the gait amplitude, which reaches 1.5 at a sprint, so a bound
   * at full speed still throws the head further than a walk does.
   */
  boundAmp: 0.10,
  boundPitch: 0.032,
  boundRoll: 0.020,
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
   * The cloud layer. The dome projects the view direction onto a flat plane at
   * `cloudElevation` and looks up two octaves of fbm at `cloudScale * 1000`.
   *
   * That 1000x is the trap. At the old 0.00016 the whole visible sky spanned
   * well under one noise cell, so there were no clouds — there was one smooth
   * gradient smeared across the dome that brightened and dimmed as you turned.
   * This puts a handful of cells between the zenith and the haze line, which is
   * the point separate cumulus start to read as separate rather than as two
   * wisps sitting on the horizon with an empty blue dome above them.
   */
  cloudScale: 0.0026,
  /**
   * Fraction of the sky with cloud in it. Only means that because sky.ts
   * renormalises the noise first — see the comment on the mask there. A bit
   * under half is a good afternoon: enough gaps that the blue still reads.
   */
  cloudCoverage: 0.44,
  /** Opacity of a fully-masked cloud. Near 1, so cumulus actually hide the sky. */
  cloudDensity: 0.95,
  /**
   * Cloud radiance, as a multiple of the sun intensity term. The stock 0.00002
   * puts a lit cloud two orders of magnitude below the sky it sits in front of,
   * so "clouds" came out as a grey wash that dimmed the dome. Calibrated in the
   * renderer so a white cloud away from the sun is a little brighter than the
   * zenith behind it, which is what makes it read as lit rather than as a hole.
   */
  cloudBright: 0.0026,
  /**
   * How low the cloud deck sits. Lower numbers push the plane further away, so
   * the clouds spread up the dome instead of piling into a band just above the
   * haze — which is what an empty zenith looks like when you fix it.
   */
  cloudElevation: 0.38,
  /**
   * Drift, in the same pre-1000x units: this times 1000 is noise cells per
   * second. About seven cells span the sky between the zenith and the haze
   * line, so 1.4e-4 walks a cloud right across the view in roughly fifty
   * seconds. The old 2.2e-5 took five minutes to do the same, which over the
   * length of one hunt is a painted backdrop rather than weather — you could
   * stand and watch and nothing up there would have moved.
   */
  cloudDrift: 0.00014,
  /**
   * Moonlit cloud. The stock shader multiplies cloud colour by the sun's
   * intensity term, which is zero once the sun is down — so at night the clouds
   * turn into black holes punched in the star field. This is the floor they are
   * lit to instead, faded in by the same `stars` ramp as the night sky.
   */
  cloudMoon: 0x38507e,
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
  /**
   * Nominal seconds per rotation, *before* `dwell` stretches and squeezes it.
   * The weights below average to 1.07, so the real cycle is a little over
   * thirty-two minutes: about sixteen of daylight falling into a long evening,
   * then sixteen of night coming back up to dawn.
   */
  period: 1800,
  /**
   * Mid-morning, with the sun still climbing. Opening at 0.472 put it four
   * hundredths of a rotation from setting, so the hunt began with the sun
   * dropping straight out of the sky — the one part of the arc where elevation
   * changes fastest, and the reason the cycle read as a light being switched
   * off rather than as a day passing. From here it climbs for a third of the
   * rotation, crosses overhead, and only then goes down.
   */
  start: 0.045,
  /** Peak sun elevation in degrees; elevation follows sin(2*pi*t) times this. */
  maxElevation: 62,
  /**
   * Compass bearing of the sun at noon (t = 0.25), from which the whole arc is
   * laid out: sunrise 90 degrees before it, sunset 90 after. 168 puts midday
   * over the village, so the player still stalks in toward the light and every
   * hut and villager is rimmed by it for most of the day.
   */
  noonAzimuth: 168,
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

  /**
   * `dwell` is a multiplier on how long the clock lingers at that point in the
   * rotation: `t` advances by `dt / (period * dwell)`, so 1.6 means the golden
   * hour passes at five eighths of nominal speed and 0.8 means midnight passes
   * at a quarter again faster.
   *
   * A uniform clock cannot give a good hunt. Elevation follows sin(2*pi*t), so
   * the interesting light — the twenty degrees either side of the horizon — is
   * only a tenth of the rotation, and at a flat rate the whole sunset is over
   * before you have crossed the village.
   *
   * But the weights have to stay *close* to each other. The old table ran from
   * 3.2 down to 0.42, a factor of nearly eight, and a clock that changes speed
   * eightfold is one you can see changing speed: the sun would hang on the
   * horizon, then visibly break into a run once it was under. This range is a
   * factor of two, which is enough to buy a long dusk and still read as one
   * steady day going past.
   */
  /**
   * A note on the `sunI` column, because it is not the light's intensity.
   *
   * It is the irradiance the key light lands on *level ground* — near enough to
   * "how bright the lit dirt reads". The elevation term is divided back out in
   * DayNight.keyIntensity() before the DirectionalLight ever sees it.
   *
   * Authoring intensity directly is what blew the day out. Ground brightness is
   * `intensity * sin(elevation)`, and this table used to raise intensity toward
   * noon while sin(elevation) was climbing from 0.19 to 0.88 underneath it — the
   * same factor counted twice. Noon came out at six and a half times the golden
   * hour every material in the game had been tuned against, so the paths clipped
   * to white, the tiger's stripes went to cream and the whole frame read milky.
   * Worse, it was invisible in the table: the numbers looked like a gentle
   * morning-to-noon ramp.
   *
   * As irradiance the column is directly comparable down its own length, which
   * is the only way to see that a bright moonlit night should not out-light noon.
   * The night rows below are the exact irradiances the old numbers were already
   * producing, so nightfall is untouched.
   *
   * And a note on `env`, because the two columns were fighting each other.
   *
   * `env` scales an IBL baked from the sky dome — and the bake used to include
   * the sun disc, which Preetham renders at sunE * 19000. Prefiltered into the
   * roughness-1 mip that lambert surfaces read, that one small hot patch arrived
   * as *ambient* light: 8.5 units of ground irradiance at noon against 0.5 from
   * the actual DirectionalLight. Sixteen times the key light, coming from
   * everywhere at once. It is why the near ground clipped to white in the morning
   * while golden hour looked right — the disc's contribution scales with
   * sin(elevation) and with atmospheric extinction, so it is worth almost nothing
   * at a 10-degree sun and everything at a 62-degree one, and no amount of
   * exposure could hold both ends of that.
   *
   * With the disc out of the bake (see render/sky.ts, which zeroes showSunDisc
   * around the PMREM call) the day rows had to take that energy back into the
   * column it belonged in. The day `sunI` values are therefore much larger than
   * they look next to the old table, and `env` is *lower*: the same total light
   * on lit ground, but coming from a direction, so normal maps read and shadows
   * exist. Shadow-side brightness is deliberately left near where it was, since
   * the golden hour was signed off with those shadows.
   */
  phases: [
    // t      turbidity rayleigh  mie    dome   sun       sunI  skyBounce gndBounce bounceI env   fogSun    fogAway   density  stars exposure dwell
    { t: 0.000, turbidity: 4.2, rayleigh: 3.4, mie: 0.010, dome: 0.55, sun: 0xffb070, sunI: 2.60, skyB: 0x9fb6d8, gndB: 0x6a5a38, bounceI: 0.85, env: 1.05, fogSun: 0xffb98a, fogAway: 0x9aa9bd, density: 0.0075, stars: 0.25, exposure: 1.00, dwell: 1.35 },
    { t: 0.120, turbidity: 2.6, rayleigh: 2.2, mie: 0.005, dome: 0.30, sun: 0xfff0d8, sunI: 4.20, skyB: 0x8fb4e6, gndB: 0x7a6a48, bounceI: 0.70, env: 1.20, fogSun: 0xcdd8e6, fogAway: 0x8ea6c6, density: 0.0030, stars: 0.00, exposure: 0.84, dwell: 1.00 },
    { t: 0.250, turbidity: 2.2, rayleigh: 1.6, mie: 0.004, dome: 0.26, sun: 0xfffaf0, sunI: 4.55, skyB: 0x9cc4ff, gndB: 0x8a7a58, bounceI: 0.72, env: 1.15, fogSun: 0xd6e2f0, fogAway: 0x97b0d0, density: 0.0024, stars: 0.00, exposure: 0.80, dwell: 0.85 },
    { t: 0.400, turbidity: 2.8, rayleigh: 2.4, mie: 0.005, dome: 0.32, sun: 0xffe6c0, sunI: 4.20, skyB: 0x8fb0dd, gndB: 0x7d6a44, bounceI: 0.75, env: 1.25, fogSun: 0xf2c99a, fogAway: 0x8ea2be, density: 0.0032, stars: 0.00, exposure: 0.86, dwell: 1.15 },
    { t: 0.472, turbidity: 3.2, rayleigh: 3.0, mie: 0.006, dome: 0.42, sun: 0xffd0a0, sunI: 2.65, skyB: 0x6f90bd, gndB: 0x6a5a38, bounceI: 1.15, env: 2.4, fogSun: 0xffc286, fogAway: 0x8fa2ba, density: 0.0055, stars: 0.05, exposure: 1.00, dwell: 1.60 },
    { t: 0.520, turbidity: 4.6, rayleigh: 4.0, mie: 0.011, dome: 0.46, sun: 0xff8b46, sunI: 0.29, skyB: 0x50648c, gndB: 0x50432c, bounceI: 1.20, env: 2.1, fogSun: 0xff9a5a, fogAway: 0x6d7e9c, density: 0.0075, stars: 0.30, exposure: 1.05, dwell: 1.55 },
    // Night is lit by a moon, not by nothing. Real moonlight is about a
    // millionth of daylight, which on screen is an unplayable black frame — so
    // the night rows are a stylised moonlit blue: bright enough to read the
    // terrain and the prey, cold and low-contrast enough to still feel like
    // night. The exposure lift and the desaturated key light do most of it,
    // the village practicals in world/lamps.ts light the rest, and the grade's
    // night-eye lift in postfx.ts catches whatever is left in the shadows.
    { t: 0.580, turbidity: 5.4, rayleigh: 4.6, mie: 0.008, dome: 1.25, sun: 0xa8c0f0, sunI: 1.20, skyB: 0x5c7cab, gndB: 0x3b3d3c, bounceI: 2.50, env: 2.7, fogSun: 0x7787b2, fogAway: 0x46536f, density: 0.0080, stars: 0.85, exposure: 1.22, dwell: 1.10 },
    { t: 0.750, turbidity: 6.0, rayleigh: 3.0, mie: 0.004, dome: 1.55, sun: 0xc2d4ff, sunI: 2.74, skyB: 0x6284bd, gndB: 0x3f4656, bounceI: 2.80, env: 3.0, fogSun: 0x88a2d8, fogAway: 0x33415f, density: 0.0075, stars: 1.00, exposure: 1.32, dwell: 0.80 },
    { t: 0.920, turbidity: 5.0, rayleigh: 4.2, mie: 0.006, dome: 1.30, sun: 0xb6c8ec, sunI: 1.25, skyB: 0x5e7dab, gndB: 0x3c3f42, bounceI: 2.60, env: 2.8, fogSun: 0x8594bc, fogAway: 0x4b5875, density: 0.0085, stars: 0.70, exposure: 1.22, dwell: 1.00 },
  ],
}

/**
 * The village after dark.
 *
 * A fixed pool of point lights, because three keys every material's shader
 * program on the scene's light count — a light appearing or disappearing
 * recompiles the world and stalls the frame. The pool is allocated once and
 * never resized; each frame it is dealt out to the nearest fires and doorways,
 * so the budget is always spent on what the player can actually see.
 */
export const LIGHTS = {
  /** Lights in the pool. Every one of them exists for the whole session. */
  pool: 10,
  /** Warm, short-range and physically falling off, so it pools on the ground. */
  fireColor: 0xff7a22,
  fireIntensity: 30,
  fireRange: 30,
  /** Oil lamps behind the doorways and window shutters. */
  lampColor: 0xffa845,
  lampIntensity: 11,
  lampRange: 15,
  /** Practicals fade out in daylight, where they would only wash the huts. */
  dayFloor: 0.12,
  /** Lamps are lit from dusk; this is the `stars` value they come up over. */
  lightUpAt: 0.18,
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
  /**
   * Night eye. A tiger's tapetum lucidum gives it roughly six times a human's
   * low-light sensitivity, and this is the grade that stands in for it: the
   * shadows are lifted, dim colour drains toward blue because rods can't see
   * hue, and the vignette gets out of the way so the dark corners of frame stay
   * legible. Anything bright — fire, a lamp, a lit doorway — keeps its colour,
   * which is what sells it as an eye adapting rather than a blue filter.
   *
   * Scaled by DayNight.darkness, so 1.0 here is the look at true midnight.
   */
  nightEye: 1.0,
  /**
   * ...but `darkness` is the `stars` ramp, and that ramp does not reach zero
   * until well after sunrise: it is still 0.18 at the opening t=0.045, with the
   * sun 17 degrees up. So the tiger's night vision was running in broad
   * daylight, putting a col^(1/1.16) lift under the morning shadows and draining
   * hue out of anything darker than mid-grey — part of why the morning read
   * washed out and flat. These two thresholds knee it off: below `onset` there is
   * no night eye at all, above `full` the value passes through untouched, so the
   * night itself is bit-for-bit what it was.
   */
  nightEyeOnset: 0.22,
  nightEyeFull: 0.5,
}

/**
 * The mix.
 *
 * Everything you hear is synthesised at runtime — there is not a single audio
 * file in the build — so these are the knobs a mixing engineer would reach for
 * rather than per-asset volumes: bus trims, the distance model, and how hard
 * the score gets out of the way when something loud happens.
 */
export const AUDIO = {
  /** Bus trims, pre-limiter. */
  master: 0.92,
  sfx: 1.0,
  music: 0.55,
  ambience: 0.42,

  /**
   * Distance model. Inverse-square alone makes anything past 30 m inaudible and
   * anything under 3 m deafening, so this is inverse-plus-quadratic: gentle up
   * close, steep out where a rifle should still read as a rifle but a distant one.
   */
  falloff: 0.055,
  falloffSq: 0.0016,
  /**
   * Air absorption, in nepers per metre of high-frequency rolloff. Sound loses
   * treble before it loses volume, which is the single cue that separates "a
   * shot forty metres away" from "a quiet shot next to your ear".
   */
  airAbsorption: 0.021,
  airFloor: 420,
  /** Metres per second. Distant gunshots arrive late, because they do. */
  speedOfSound: 343,
  /** Rifles carry further than bodies do. See `Place.roll`. */
  gunRoll: 0.3,

  /** Concurrent voice budget. Past this, low-priority one-shots are dropped. */
  maxVoices: 40,

  /** Two reverbs: a tight treeline slap and the long valley behind it. */
  nearSeconds: 0.55,
  nearDecay: 2.6,
  farSeconds: 2.9,
  farDecay: 1.5,
  /** Base send levels; both scale up with distance. */
  wetNear: 0.20,
  wetFar: 0.09,
  /**
   * How much wetter a sound gets with distance, as an exponent on the distance
   * attenuation. 0 keeps the wet/dry ratio fixed; 1 would hold the wet level
   * flat no matter how far away the source is. Anything above 1 would make
   * distant sounds louder than near ones, which is not a mix, it is a bug.
   */
  wetSlopeNear: 0.4,
  wetSlopeFar: 0.7,
  /** Ceiling on that, so a shot across the map is not pure reverb. */
  wetSpreadMax: 3.5,

  /**
   * Mix-bus soft clipping. Below `satCeiling / 3` the curve is exactly linear
   * and nothing happens at all; between there and `satCeiling * 2 / 3` it
   * bends; above that it is flat. So this number sets where the mix stops
   * being allowed to get louder — and, because the linear region has to cover
   * every normal sound, it also sets the loudest a normal sound may be.
   */
  satCeiling: 2.0,
  satMakeup: 0.95,

  /** Sidechain. Big events pull the score down and let it back up. */
  duckAmount: 0.55,
  duckAttack: 0.035,
  duckRelease: 0.42,
}

/**
 * The score.
 *
 * A single evolving piece rather than a playlist: one scheduler runs a bar
 * clock for the whole session and each layer is faded in by the hunt number and
 * by how much trouble the player is in. Hunt 1 is a tanpura drone and a
 * heartbeat; hunt 8 with three rifles on you is drums, a sitar ostinato, brass
 * and a dissonant string cluster, twenty beats a minute faster and a mode
 * darker. Nothing loops back to the top, so it never reads as a track repeating.
 */
export const MUSIC = {
  /** Tempo = base + wave ramp + intensity ramp (+ frenzy). */
  bpmBase: 76,
  bpmPerWave: 4.5,
  bpmIntensity: 16,
  bpmFrenzy: 13,
  /** Hunts past this stop adding tempo; it is already a siege. */
  waveCap: 8,

  /** Root pitch, A1. Everything is derived from it. */
  root: 55,
  /**
   * The mode turns at this hunt. Aeolian for the early nights — sad, ordinary
   * minor — then Phrygian dominant, whose flat second over a major third is the
   * interval that makes the back of your neck go cold.
   */
  exoticFrom: 4,

  /**
   * Which hunt each layer unlocks on, and how much combat intensity it needs
   * before it comes up. Two gates, because a layer that only tracks the hunt
   * number never reacts and one that only tracks intensity never grows.
   */
  layers: {
    drone: { wave: 1, need: 0.0 },
    pulse: { wave: 1, need: 0.0 },
    bass: { wave: 1, need: 0.18 },
    frame: { wave: 2, need: 0.10 },
    ostinato: { wave: 3, need: 0.22 },
    taiko: { wave: 4, need: 0.15 },
    brass: { wave: 5, need: 0.35 },
    choir: { wave: 6, need: 0.20 },
    strings: { wave: 7, need: 0.45 },
  },

  /** Seconds for the intensity signal to chase combat. Slow up, slower down. */
  riseTime: 1.1,
  fallTime: 4.5,
  /** Scheduler: how far ahead notes are queued, and how often we top it up. */
  lookahead: 0.22,
  tickMs: 28,
}

/**
 * Per-voice output trims — the mix, in one place.
 *
 * Every sound in `audio.ts` is built from layers whose gains are chosen for
 * *timbre*: how much crack against how much body, how much tear against how
 * much sub. Those numbers say nothing about how loud the finished sound should
 * be relative to every other sound, and if you try to make them do both jobs
 * you can never change one without breaking the other.
 *
 * So they don't. Each voice is designed at whatever internal level sounds
 * right, then scaled once on its way to the bus by the trim below. These
 * numbers were set by rendering each sound offline and measuring its loudest
 * 300 ms window, then adjusting until the table read the way a mix should:
 * gunfire and the roar at the top, impacts just under them, texture far below.
 *
 * The ordering matters more than the absolute values. A rifle going off six
 * metres away has to be the most alarming thing you can hear, or the hunters
 * are not frightening; a footstep has to sit thirty decibels down, or the
 * player stops hearing anything else.
 */
export const LEVELS = {
  // Apex: the sounds allowed to take over the mix. These are the only ones
  // that should ever reach the soft clipper, and only on their transient.
  gunshot: 1.7,
  roar: 0.5,
  biteKill: 2.0,

  // Impacts. Loud, but they must not outrun the gun, and — more importantly —
  // they must not be sitting on the ceiling when a gun goes off on top of them.
  clawHit: 3.0,
  land: 1.4,
  hurt: 1.5,

  // Voices. Two humans yelling at each other across a village is most of what
  // sells the place as inhabited, so they are not allowed to disappear.
  scream: 1.6,
  shout: 5.5,
  growl: 7.0,

  // Stingers. These were eating the whole headroom; they are deliberately
  // under the gun now, and they duck the score instead of shouting over it.
  waveStart: 0.2,
  gameOver: 0.4,
  frenzy: 0.26,
  powerup: 0.5,

  // Texture. Constant, so it lives a long way down. A footstep at the same
  // peak level as a claw strike is not a loud footstep, it is a broken mix:
  // every step steals a decibel of the limiter from whatever else is playing.
  swipe: 3.0,
  bulletWhiz: 9.0,
  pounce: 9.0,
  footstep: 4.5,
  pickup: 1.6,
  comboTick: 1.4,
  distantShot: 1.6,
}

export const STORAGE_KEY = 'killer-tiger:best'
