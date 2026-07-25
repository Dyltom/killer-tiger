/** Bootstrap: renderer, loop, overlays, and the plumbing between them. */
import * as THREE from 'three'
import { CAMERA, POST, TIGER } from './config'
import { audio } from './engine/audio'
import { Input } from './engine/input'
import { Quality } from './engine/quality'
import { Game } from './game'
import { installAtmosphericFog, makeFog } from './render/atmosphere'
import { PostFX } from './render/postfx'
import { Sky } from './render/sky'
import { Hud } from './ui/hud'
import { initMaterials, loadingManager } from './world/materials'
import { World } from './world/world'

// Must run before the first material is compiled — it rewrites the shader
// chunks every fog-enabled material is assembled from.
installAtmosphericFog()

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

/**
 * `?nolock` runs the game without requiring pointer lock. Embedded webviews
 * and headless screenshot runs can't grab the pointer, so this keeps the game
 * drivable for testing. Mouse-look is disabled; keyboard still works.
 */
const NOLOCK = new URLSearchParams(location.search).has('nolock')

const app = $('app')
const menu = $('menu')
const pausedEl = $('paused')
const gameoverEl = $('gameover')
const loading = $('loading')

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
})
renderer.setSize(innerWidth, innerHeight)
// Provisional; the quality manager takes this over below and keeps adjusting it.
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = POST.exposure
renderer.outputColorSpace = THREE.SRGBColorSpace
app.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.fog = makeFog()

const camera = new THREE.PerspectiveCamera(CAMERA.fov, innerWidth / innerHeight, CAMERA.near, CAMERA.far)
camera.rotation.order = 'YXZ'
scene.add(camera)

initMaterials(renderer)

const sky = new Sky(scene)
sky.buildEnvironment(renderer)

const input = new Input(renderer.domElement)
input.nolock = NOLOCK
const hud = new Hud()
const world = new World(scene)
const game = new Game(scene, camera, world, hud)
const postfx = new PostFX(renderer, scene, camera, sky.sunDir)

// ------------------------------------------------------------- quality
// One place decides how expensive a frame is allowed to be, and it decides it
// from measured frame time rather than from a settings menu the player has no
// way to answer correctly.
const quality = new Quality()
quality.onChange = (p) => {
  renderer.setPixelRatio(Math.min(devicePixelRatio, p.pixelRatio))
  postfx.setSize(innerWidth, innerHeight)
  postfx.setQuality(p)
  sky.setShadowQuality(p.shadowMapSize, p.shadowExtent)
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
  } else if (state === 'paused') {
    showOnly(pausedEl)
    input.releaseLock()
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
  }
}

function beginHunt() {
  audio.init()
  audio.resume()
  audio.startAmbience()
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
    game, world, input, camera, renderer, scene, sky, postfx, quality, THREE,
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

addEventListener('keydown', (e) => {
  if (e.code === 'KeyR' && game.state === 'dead') beginHunt()
  if (e.code === 'KeyM') audio.setMuted(!audio.muted)
  if (e.code === 'Escape' && game.state === 'paused') {
    // ESC out of pause goes back to the menu.
    showOnly(menu)
  }
})

// ------------------------------------------------------------------- loop
const clock = new THREE.Clock()

/** One simulation + render step. Split out so tests can drive it directly. */
function frame(dt: number) {
  if (game.state === 'playing') quality.sample(dt)
  const controlling = (input.locked || NOLOCK) && game.state === 'playing'
  game.darkness = sky.day.darkness
  game.update(dt, input, controlling)
  input.endFrame()

  // Pause freezes the clock too; coming back to a different time of day after
  // an alt-tab reads as a bug, not as a cycle.
  if (game.state === 'playing') sky.update(dt, game.tiger.pos)
  else sky.update(0, game.tiger.pos)
  renderer.toneMappingExposure = POST.exposure * sky.day.state.exposure

  // Frenzy ramps the grade up and back down over its last second rather than
  // snapping off; hurt is driven by how close to death the tiger is.
  const frenzy = Math.min(1, game.tiger.frenzy / 1.0)
  const hurt = 1 - Math.min(1, game.tiger.health / (TIGER.maxHealth * 0.45))
  postfx.render(dt, frenzy, game.state === 'playing' ? hurt : 0, sky.day.darkness)
}

function animate() {
  // Clamp dt so an alt-tab doesn't teleport the tiger across the map.
  frame(Math.min(clock.getDelta(), 1 / 20))
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
  postfx.render(0, 0, 0)
  loading.remove()
  showOnly(menu)
  renderer.setAnimationLoop(animate)
}

loadingManager.onLoad = begin
loadingManager.onError = (url) => console.error('[assets] failed to load', url)
// Never leave the player staring at a loading screen because one file 404'd.
setTimeout(begin, 15000)
