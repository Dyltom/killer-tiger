/** Bootstrap: renderer, loop, overlays, and the plumbing between them. */
import * as THREE from 'three'
import { CAMERA, COLORS, WORLD } from './config'
import { audio } from './engine/audio'
import { Input } from './engine/input'
import { Game } from './game'
import { Hud } from './ui/hud'
import { World } from './world/world'

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
// Cap DPR: retina at 3x murders the framerate for almost no visual gain here.
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.5
renderer.outputColorSpace = THREE.SRGBColorSpace
app.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.fog = new THREE.Fog(COLORS.fog, WORLD.fogNear, WORLD.fogFar)

const camera = new THREE.PerspectiveCamera(CAMERA.fov, innerWidth / innerHeight, CAMERA.near, CAMERA.far)
camera.rotation.order = 'YXZ'
scene.add(camera)

const input = new Input(renderer.domElement)
input.nolock = NOLOCK
const hud = new Hud()
const world = new World(scene)
const game = new Game(scene, camera, world, hud)

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
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
    game, world, input, camera, renderer, scene, THREE,
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
let flameTime = 0

// Collected once — traversing the whole scene every frame is wasteful.
const flames: THREE.Object3D[] = []
scene.traverse((o) => { if (o.name === 'flame') flames.push(o) })

/** One simulation + render step. Split out so tests can drive it directly. */
function frame(dt: number) {
  flameTime += dt

  const controlling = (input.locked || NOLOCK) && game.state === 'playing'
  game.update(dt, input, controlling)
  input.endFrame()

  for (const f of flames) {
    f.scale.set(
      0.85 + Math.sin(flameTime * 9 + f.position.x) * 0.18,
      0.85 + Math.sin(flameTime * 13 + f.position.z) * 0.3,
      0.85 + Math.cos(flameTime * 11) * 0.18,
    )
    f.rotation.y = flameTime * 2
  }

  renderer.render(scene, camera)
}

function animate() {
  // Clamp dt so an alt-tab doesn't teleport the tiger across the map.
  frame(Math.min(clock.getDelta(), 1 / 20))
}
renderer.setAnimationLoop(animate)

// Warm the shader cache with one render before revealing the menu, so the
// first real frame isn't a compile stall.
renderer.render(scene, camera)
loading.remove()
showOnly(menu)
