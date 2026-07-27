/** Bootstrap: renderer, loop, overlays, and the plumbing between them. */
import * as THREE from 'three'
import { CAMERA, POST, TIGER } from './config'
import { audio } from './engine/audio'
import { Input } from './engine/input'
import { Quality } from './engine/quality'
import { attachPose } from './entities/pose'
import { Game } from './game'
import { installAtmosphericFog, makeFog } from './render/atmosphere'
import { installLightCulling } from './render/lightcull'
import { PostFX } from './render/postfx'
import { Sky } from './render/sky'
import { Hud } from './ui/hud'
import { initMaterials, loadingManager } from './world/materials'
import { terrainHeight, World } from './world/world'

// Both must run before the first material is compiled — they rewrite the shader
// chunks every material is assembled from.
installAtmosphericFog()
installLightCulling()

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

/**
 * `?nolock` runs the game without requiring pointer lock. Embedded webviews
 * and headless screenshot runs can't grab the pointer, so this keeps the game
 * drivable for testing. Mouse-look is disabled; keyboard still works.
 */
const QUERY = new URLSearchParams(location.search)
const NOLOCK = QUERY.has('nolock')

/**
 * `?t=0.25` opens at a chosen point in the day-night cycle instead of at
 * DAY.start, and `?freeze` stops the clock there.
 *
 * A full rotation is half an hour of real time, so without these, checking what
 * anything looks like at noon means either waiting or editing config.ts — and
 * editing the config to look at the game is how the shipped start time ends up
 * being whatever the last person was debugging.
 */
const START_T = QUERY.has('t') ? Number(QUERY.get('t')) : null
const FREEZE_TIME = QUERY.has('freeze')

const app = $('app')
const menu = $('menu')
const pausedEl = $('paused')
const gameoverEl = $('gameover')
const loading = $('loading')

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({
  // Not a typo. Every frame is composed in the post chain's own render targets
  // and the default framebuffer only ever receives the last fullscreen blit, so
  // asking for a multisampled back buffer buys nothing and costs the bandwidth
  // of writing four samples per pixel and resolving them. Antialiasing is the
  // final FXAA pass's job — see render/postfx.ts.
  antialias: false,
  powerPreference: 'high-performance',
})
renderer.setSize(innerWidth, innerHeight)
// Provisional; the quality manager takes this over below and keeps adjusting it.
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.shadowMap.enabled = true
// The sun's map is redrawn on a cadence the quality tier picks rather than once
// per frame — see QualityPreset.shadowInterval. Sky decides which frames those
// are, because it also owns the frustum that has to stay put on the others.
renderer.shadowMap.autoUpdate = false
// PCFSoftShadowMap is deprecated as of three r18x: the renderer swaps it for
// PCFShadowMap on the first frame and warns about it on the console. Ask for
// what we actually get. PCF is a five-tap Vogel disk of `shadow.radius` texels,
// rotated per pixel by interleaved gradient noise.
renderer.shadowMap.type = THREE.PCFShadowMap
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = POST.exposure
renderer.outputColorSpace = THREE.SRGBColorSpace
app.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.fog = makeFog()
// The cast's bone matrices are uploaded from here, once for the whole crowd
// instead of once per villager. See entities/pose.ts.
attachPose(scene)

const camera = new THREE.PerspectiveCamera(CAMERA.fov, innerWidth / innerHeight, CAMERA.near, CAMERA.far)
camera.rotation.order = 'YXZ'
scene.add(camera)

initMaterials(renderer)

const sky = new Sky(scene)
if (START_T !== null && Number.isFinite(START_T)) sky.day.setPhase(START_T)
sky.buildEnvironment(renderer)

const input = new Input(renderer.domElement)
input.nolock = NOLOCK

// One place decides how expensive a frame is allowed to be, and it decides it
// from measured frame time rather than from a settings menu the player has no
// way to answer correctly. Built before the world because the world has to know
// its opening tier: the size of the practical-light pool is baked into every
// shader in the scene and cannot be changed later. Everything else the tier
// controls is pushed through `onChange` below.
const quality = new Quality()

const hud = new Hud()
const world = new World(scene, quality.preset.lightPool)
const game = new Game(scene, camera, world, hud)
const postfx = new PostFX(renderer, scene, camera, sky.sunDir)

// ------------------------------------------------------------- quality
quality.onChange = (p) => {
  // The tier caps the pixel ratio; `renderScale` is the fine adjustment the
  // quality manager makes between tiers to hold the frame rate. Both, or the
  // fast lever does nothing.
  renderer.setPixelRatio(Math.min(devicePixelRatio, p.pixelRatio) * quality.renderScale)
  postfx.setSize(innerWidth, innerHeight)
  postfx.setQuality(p)
  sky.setShadowQuality(p.shadowMapSize, p.shadowExtent, p.shadowInterval)
  world.setFoliageDistance(p.foliageDistance)
}
quality.apply()

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
  postfx.setSize(innerWidth, innerHeight)
})

// ------------------------------------------------------------------- flow
function showOnly(el: HTMLElement | null) {
  for (const o of [menu, pausedEl, gameoverEl]) o.classList.toggle('hidden', o !== el)
}

game.onStateChange = (state) => {
  if (state === 'playing') {
    showOnly(null)
    hud.show()
    audio.resume()
    audio.setMusicMode('hunt')
  } else if (state === 'paused') {
    showOnly(pausedEl)
    input.releaseLock()
    // The score keeps playing behind the pause card, but it backs off to the
    // drone — a full arrangement under a menu is the tell of a game that
    // stopped simulating and forgot to tell its mixer.
    audio.setMusicMode('menu')
  } else if (state === 'dead') {
    hud.hide()
    input.releaseLock()
    $('go-score').textContent = String(game.score)
    $('go-kills').textContent = String(game.kills)
    $('go-wave').textContent = String(game.wave)
    $('go-best').textContent = String(Math.max(game.best, game.score))
    showOnly(gameoverEl)
  } else {
    hud.hide()
    showOnly(menu)
    audio.setMusicMode('menu')
  }
}

function beginHunt() {
  // The context can only be created inside a gesture, so everything audio is
  // brought up here rather than at module load.
  audio.init()
  audio.resume()
  audio.startAmbience()
  audio.startMusic()
  game.start()
  if (!NOLOCK) input.requestLock()
}

/**
 * Debug handle. `step()` drives the real loop at a fixed timestep, which lets
 * an automated check render deterministic frames even when the tab is
 * backgrounded and requestAnimationFrame is throttled to nothing.
 */
Object.assign(window, {
  __kt: {
    game, world, input, camera, renderer, scene, sky, postfx, quality, audio, THREE, terrainHeight,
    step: (frames = 1, dt = 1 / 60) => { for (let i = 0; i < frames; i++) frame(dt) },
    hold: (code: string) => dispatchEvent(new KeyboardEvent('keydown', { code })),
    release: (code: string) => dispatchEvent(new KeyboardEvent('keyup', { code })),
    look: (dx: number, dy = 0) => { input.mouseDX += dx; input.mouseDY += dy },
    click: (button = 0) => {
      dispatchEvent(new MouseEvent('mousedown', { button }))
      dispatchEvent(new MouseEvent('mouseup', { button }))
    },
  },
})

$('start-btn').addEventListener('click', beginHunt)
$('retry-btn').addEventListener('click', beginHunt)
$('resume-btn').addEventListener('click', () => {
  game.resume()
  input.requestLock()
})

// Clicking the canvas after ESC re-locks rather than dumping you to a menu.
renderer.domElement.addEventListener('click', () => {
  if (game.state === 'playing' && !input.locked) input.requestLock()
})

input.onLockChange = (locked) => {
  if (!locked && game.state === 'playing' && !NOLOCK) game.pause()
}

// A hidden tab still runs its timers, just badly — throttled to a second or
// more, which is long enough that anything clocked off them stutters. Rather
// than try to sequence through that, stop the clock entirely: nobody wants to
// hear the score from a tab they have alt-tabbed away from anyway.
addEventListener('visibilitychange', () => {
  if (document.hidden) audio.suspend()
  else audio.resume()
})

// -------------------------------------------------------------- fps meter
/**
 * The frame-rate readout.
 *
 * Deliberately not `quality.fps`: that average is only fed while the game is
 * playing, because it is what decides the tier and a menu frame is not a
 * gameplay frame. The readout wants the opposite — it should keep reading in
 * the menu, where the world is still being drawn behind the card and where
 * comparing that number against the in-game one is how you find out what the
 * hunt itself actually costs.
 *
 * Default on. The point of it is play-testing.
 */
const FPS_KEY = 'killer-tiger:fps'
let showFps = true
try {
  showFps = localStorage.getItem(FPS_KEY) !== '0'
} catch {
  /* private browsing — the readout just always starts on */
}
/** Exponentially smoothed frame time, ms. Seeded at 60 Hz. */
let frameMs = 16.7
let fpsClock = 0
hud.showFps(showFps)

addEventListener('keydown', (e) => {
  if (e.code === 'KeyR' && game.state === 'dead') beginHunt()
  if (e.code === 'KeyM') audio.setMuted(!audio.muted)
  if (e.code === 'KeyF') {
    showFps = !showFps
    hud.showFps(showFps)
    try {
      localStorage.setItem(FPS_KEY, showFps ? '1' : '0')
    } catch {
      /* nothing to do; the toggle still works for this session */
    }
  }
  if (e.code === 'Escape' && game.state === 'paused') {
    // ESC out of pause goes back to the menu.
    showOnly(menu)
  }
})

// ------------------------------------------------------------------- loop
// Timer rather than Clock: Clock is deprecated as of r185 and warns on the
// console, and connecting this one to the document hands the alt-tab case to
// the Page Visibility API — a hidden tab reports a zero delta instead of the
// several seconds it was away.
const timer = new THREE.Timer()
timer.connect(document)

/** One simulation + render step. Split out so tests can drive it directly. */
function frame(dt: number) {
  audio.tickMusic()
  updateFps(dt)
  if (game.state === 'playing') quality.sample(dt)
  const controlling = (input.locked || NOLOCK) && game.state === 'playing'
  game.darkness = sky.day.darkness
  game.update(dt, input, controlling)
  input.endFrame()

  // Pause freezes the clock too; coming back to a different time of day after
  // an alt-tab reads as a bug, not as a cycle.
  if (game.state === 'playing' && !FREEZE_TIME) sky.update(dt, game.tiger.pos)
  else sky.update(0, game.tiger.pos)
  renderer.shadowMap.needsUpdate = sky.shadowDirty
  renderer.toneMappingExposure = POST.exposure * sky.day.state.exposure

  // Frenzy ramps the grade up and back down over its last second rather than
  // snapping off; hurt is driven by how close to death the tiger is.
  const frenzy = Math.min(1, game.tiger.frenzy / 1.0)
  const hurt = 1 - Math.min(1, game.tiger.health / (TIGER.maxHealth * 0.45))
  postfx.render(dt, frenzy, game.state === 'playing' ? hurt : 0, sky.day.darkness)
}

/**
 * Ten frames of smoothing, refreshed on screen five times a second.
 *
 * Both numbers are about being readable rather than about being precise: a
 * per-frame figure is a blur, and a per-second one hides the half-second the
 * frame rate fell over. The resolution is worth carrying because the tier and
 * the render scale are what the quality manager changes underneath you, and a
 * frame rate that recovered because the game quietly dropped to 78% of the
 * pixels is not the same news as one that recovered on its own.
 */
function updateFps(dt: number) {
  frameMs += (dt * 1000 - frameMs) * 0.1
  fpsClock += dt
  if (!showFps || fpsClock < 0.2) return
  fpsClock = 0
  const w = Math.round(innerWidth * renderer.getPixelRatio())
  const h = Math.round(innerHeight * renderer.getPixelRatio())
  hud.setFps(
    `${(1000 / frameMs).toFixed(0)} fps  ${frameMs.toFixed(1)} ms\n` +
      `${quality.preset.name}  ${Math.round(quality.renderScale * 100)}%  ${w}x${h}`,
  )
}

function animate(timestamp: number) {
  timer.update(timestamp)
  // Still clamped: the visibility handler covers alt-tab, but a long GC pause or
  // a shader compile can hand us a delta big enough to teleport the tiger.
  frame(Math.min(timer.getDelta(), 1 / 20))
}

/**
 * Compile the program for everything in the scene, including what is currently
 * hidden.
 *
 * A warm frame only warms what that frame drew, and three's `compile()` walks
 * the scene with `traverseVisible`, so both of them skip exactly the things
 * that are pooled-and-hidden at boot: all 52 humans, every pickup, every blood
 * decal. Which means the first villager of wave one compiled the skinned human
 * program, the first kill compiled the decal program, and the first pickup
 * compiled its own — three separate hundred-millisecond stalls, each landing on
 * the single frame the player most wanted to be smooth, and each looking for
 * all the world like a performance problem in the thing that had just spawned.
 *
 * So show everything for as long as it takes to compile, then put it back. The
 * loading screen is still up over the canvas, so there is nothing to see.
 *
 * The shadow pass needs its own pass over the same set, because `compile()` only
 * builds the program a material draws itself with — the depth material the
 * shadow map substitutes in is compiled lazily by the shadow renderer, and a
 * skinned depth program is its own variant. Measured, that was the last six
 * programs, and it cost the frame a villager first stepped into the sun.
 *
 * That warming pass has to go through the post chain rather than straight to
 * the canvas. A program's cache key includes the output colour space of the
 * target it is drawn into, and every real frame is drawn into a linear render
 * target while the canvas is sRGB — so warming with a plain `render()` compiles
 * a whole set of variants the game will never use and leaves the ones it does
 * still cold. That is a warm-up that costs load time and buys nothing, which is
 * worse than not doing it.
 */
function warmShaderCache() {
  const hidden: THREE.Object3D[] = []
  scene.traverse((o) => {
    if (!o.visible) {
      hidden.push(o)
      o.visible = true
    }
  })
  renderer.compile(scene, camera)
  renderer.shadowMap.needsUpdate = true
  postfx.render(0, 0, 0)
  for (const o of hidden) o.visible = false
}

/**
 * Hold the menu back until the PBR sets are decoded, then warm the shader cache
 * with one real frame. Compiling the terrain and foliage programs mid-hunt is a
 * visible multi-hundred-millisecond stall.
 */
let started = false
function begin() {
  if (started) return
  started = true
  warmShaderCache()
  // Then a second frame with only what the menu should actually show. The warm
  // pass left the shadow map holding 52 hidden humans stacked at the origin,
  // and this is what replaces it — nothing has run the loop yet, so without a
  // real render here the first frame samples a map that is wrong or missing.
  renderer.shadowMap.needsUpdate = true
  postfx.render(0, 0, 0)
  loading.remove()
  showOnly(menu)
  renderer.setAnimationLoop(animate)
}

loadingManager.onLoad = begin
loadingManager.onError = (url) => console.error('[assets] failed to load', url)
// Never leave the player staring at a loading screen because one file 404'd.
setTimeout(begin, 15000)
