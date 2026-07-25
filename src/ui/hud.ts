/** All DOM reads/writes live here so the game loop never touches the document. */

import type { Human } from '../entities/human'
import type { Pickup } from '../entities/pickup'
import { PICKUP_TYPES } from '../entities/pickup'
import { WORLD } from '../config'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

export interface BuffChip {
  label: string
  remaining: number
}

export class Hud {
  private hud = $('hud')
  private scoreEl = $('score')
  private comboEl = $('combo')
  private waveEl = $('wave')
  private objectiveEl = $('objective')
  private threatEl = $('threat')
  private hpFill = $('hp-fill')
  private stamFill = $('stam-fill')
  private rageFill = $('rage-fill')
  private rageMeter = $('rage-meter')
  private rageHint = $('rage-hint')
  private buffsEl = $('buffs')
  private feedEl = $('feed')
  private announceEl = $('announce')
  private announceBig = this.announceEl.querySelector('.big') as HTMLElement
  private announceSmall = this.announceEl.querySelector('.small') as HTMLElement
  private hitmark = $('hitmark')
  private reticle = $('reticle')
  private damageFlash = $('damage-flash')
  private frenzyTint = $('frenzy-tint')
  private vignette = $('vignette')
  private critical = $('critical')
  private pulse = $('pulse')
  private devour = $('devour')
  private devourFill = $('devour-fill')
  private radar = $<HTMLCanvasElement>('radar')
  private radarCtx = this.radar.getContext('2d')!

  private shownScore = 0
  private feedItems: { el: HTMLElement; t: number }[] = []
  private lastBuffKey = ''

  show() { this.hud.classList.remove('hidden') }
  hide() { this.hud.classList.add('hidden') }

  setScore(score: number) {
    // Roll the number up so kills feel like they pay out.
    this.shownScore += (score - this.shownScore) * 0.24
    if (Math.abs(score - this.shownScore) < 1) this.shownScore = score
    this.scoreEl.textContent = String(Math.round(this.shownScore))
  }

  setCombo(chain: number, mult: number) {
    if (chain <= 1) {
      this.comboEl.style.opacity = '0'
      return
    }
    this.comboEl.style.opacity = '1'
    this.comboEl.textContent = `${chain} CHAIN  ×${mult.toFixed(2)}`
  }

  setWave(n: number, killed: number, needed: number) {
    this.waveEl.textContent = `Hunt ${n}`
    this.objectiveEl.textContent = `${Math.min(killed, needed)} / ${needed} prey`
  }

  setThreat(alerted: number, hunters: number) {
    const alert = alerted > 0
    this.threatEl.classList.toggle('alert', alert)
    if (!alert) this.threatEl.textContent = 'Undetected'
    else if (hunters > 0) this.threatEl.textContent = `Hunted — ${hunters} rifle${hunters > 1 ? 's' : ''} on you`
    else this.threatEl.textContent = `Spotted — ${alerted} fleeing`
  }

  setMeters(hp: number, stam: number, rage: number, frenzyActive: boolean) {
    this.hpFill.style.transform = `scaleX(${Math.max(0, hp)})`
    this.stamFill.style.transform = `scaleX(${Math.max(0, stam)})`
    this.rageFill.style.transform = `scaleX(${Math.max(0, rage)})`
    const ready = rage >= 0.999 && !frenzyActive
    this.rageMeter.classList.toggle('ready', ready)
    this.rageHint.textContent = frenzyActive ? 'FRENZY' : ready ? 'PRESS Q' : ''
    // Health vignette closes in as you bleed out.
    const dark = 220 + (1 - hp) * 200
    const spread = 60 + (1 - hp) * 90
    this.vignette.style.boxShadow = `inset 0 0 ${dark}px ${spread}px rgba(${Math.round((1 - hp) * 40)}, 0, 0, ${0.72 + (1 - hp) * 0.2})`

    // Below half health the frame starts bleeding, and below a quarter the
    // heartbeat comes through it. Both ramp rather than switching on, so the
    // state of the tiger is legible from the picture at any moment without
    // having to glance at the bar.
    const hurt = Math.max(0, 1 - hp / 0.55)
    const dying = Math.max(0, 1 - hp / 0.28)
    this.critical.style.opacity = (hurt * hurt * 0.9).toFixed(3)
    this.pulse.style.opacity = (dying * 0.55).toFixed(3)
    // The beat quickens as it gets worse.
    this.pulse.style.animationDuration = `${(1.15 - dying * 0.5).toFixed(2)}s`
  }

  /** Progress on the corpse being eaten; a negative value hides the prompt. */
  setDevour(progress: number) {
    if (progress < 0) {
      this.devour.style.opacity = '0'
      return
    }
    this.devour.style.opacity = '1'
    this.devourFill.style.transform = `scaleX(${Math.min(1, progress)})`
  }

  setBuffs(chips: BuffChip[]) {
    const key = chips.map((c) => c.label + Math.ceil(c.remaining)).join('|')
    if (key === this.lastBuffKey) return
    this.lastBuffKey = key
    this.buffsEl.replaceChildren(
      ...chips.map((c) => {
        const el = document.createElement('div')
        el.className = 'buff'
        el.innerHTML = `<span>${c.label}</span><span class="t">${c.remaining.toFixed(0)}s</span>`
        return el
      }),
    )
  }

  setReticleHot(hot: boolean) {
    this.reticle.classList.toggle('hot', hot)
  }

  hitMarker(crit: boolean) {
    this.hitmark.classList.toggle('crit', crit)
    this.hitmark.classList.remove('pop')
    void this.hitmark.offsetWidth // restart the animation
    this.hitmark.classList.add('pop')
  }

  flashDamage() {
    this.damageFlash.style.opacity = '0.9'
    setTimeout(() => { this.damageFlash.style.opacity = '0' }, 90)
  }

  setFrenzy(on: boolean) {
    this.frenzyTint.style.opacity = on ? '1' : '0'
  }

  toast(text: string, tone: 'kill' | 'good' | 'bad' = 'kill') {
    const el = document.createElement('div')
    el.className = `toast ${tone}`
    el.textContent = text
    this.feedEl.prepend(el)
    this.feedItems.unshift({ el, t: 0 })
    while (this.feedItems.length > 6) {
      this.feedItems.pop()?.el.remove()
    }
  }

  announce(big: string, small = '') {
    this.announceBig.textContent = big
    this.announceSmall.textContent = small
    this.announceEl.classList.remove('show')
    void this.announceEl.offsetWidth
    this.announceEl.classList.add('show')
  }

  updateFeed(dt: number) {
    for (let i = this.feedItems.length - 1; i >= 0; i--) {
      const item = this.feedItems[i]!
      item.t += dt
      if (item.t > 3.2) {
        item.el.style.opacity = String(Math.max(0, 1 - (item.t - 3.2) * 2))
      }
      if (item.t > 3.8) {
        item.el.remove()
        this.feedItems.splice(i, 1)
      }
    }
  }

  /** Top-down radar: prey as dots, hunters as triangles, pickups as diamonds. */
  drawRadar(
    tigerX: number, tigerZ: number, tigerYaw: number,
    humans: Human[], pickups: Pickup[], bloodScent: boolean,
  ) {
    const c = this.radarCtx
    const w = this.radar.width
    const cx = w / 2
    const R = w / 2 - 8
    const range = bloodScent ? WORLD.bounds : 62
    c.clearRect(0, 0, w, w)

    // Rings + facing wedge.
    c.strokeStyle = 'rgba(255,255,255,0.10)'
    c.lineWidth = 2
    for (const f of [0.34, 0.67, 1]) {
      c.beginPath(); c.arc(cx, cx, R * f, 0, Math.PI * 2); c.stroke()
    }
    c.fillStyle = 'rgba(255,176,58,0.10)'
    c.beginPath()
    c.moveTo(cx, cx)
    c.arc(cx, cx, R, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5)
    c.closePath()
    c.fill()

    /**
     * World offset into radar space, so "up" is wherever the tiger is looking.
     *
     * Worth deriving rather than eyeballing, because the sign errors here are
     * invisible when you're standing still and mirror the whole world the moment
     * you turn. The tiger's basis (see tiger.ts) is
     *   forward = (-sin y, -cos y)   right = (cos y, -sin y)
     * so a blip's radar-right is `d · right` and its radar-up is `d · forward`;
     * canvas y grows downward, so screen y is the negation of that:
     *   rx =  dx cos y - dz sin y
     *   ry = -(-dx sin y - dz cos y) = dx sin y + dz cos y
     * The old form rotated by -yaw, which is that same pair reflected — every
     * contact appeared on the wrong side of you as soon as you weren't facing
     * north.
     */
    const project = (x: number, z: number) => {
      const dx = x - tigerX
      const dz = z - tigerZ
      const s = Math.sin(tigerYaw)
      const co = Math.cos(tigerYaw)
      const rx = dx * co - dz * s
      const ry = dx * s + dz * co
      return { x: cx + (rx / range) * R, y: cx + (ry / range) * R, d: Math.hypot(dx, dz) }
    }

    /** Pin an off-radar contact to the rim, keeping its bearing. */
    const rim = (q: { x: number; y: number }) => {
      const ox = q.x - cx
      const oy = q.y - cx
      const m = Math.hypot(ox, oy) || 1
      return { x: cx + (ox / m) * R, y: cx + (oy / m) * R, a: Math.atan2(oy, ox) }
    }

    for (const p of pickups) {
      if (!p.active) continue
      const q = project(p.group.position.x, p.group.position.z)
      if (q.d > range) continue
      c.fillStyle = `#${PICKUP_TYPES[p.id].color.toString(16).padStart(6, '0')}`
      c.save()
      c.translate(q.x, q.y)
      c.rotate(Math.PI / 4)
      c.fillRect(-3.5, -3.5, 7, 7)
      c.restore()
    }

    for (const h of humans) {
      if (!h.group.visible) continue
      const q = project(h.pos.x, h.pos.z)
      if (q.d > range) {
        // A hunter who has seen you is the one thing worth knowing about from
        // outside radar range: pin the bearing to the rim rather than dropping
        // the contact, so you can tell which way the shot is coming from.
        if (!h.alive || h.kind !== 'hunter' || !h.alerted) continue
        const r = rim(q)
        c.fillStyle = '#ff4d3d'
        c.save()
        c.translate(r.x, r.y)
        c.rotate(r.a)
        c.globalAlpha = 0.8
        c.beginPath()
        c.moveTo(3, 0); c.lineTo(-3, 3.5); c.lineTo(-3, -3.5)
        c.closePath()
        c.fill()
        c.restore()
        continue
      }
      // Bodies you can still eat. Health comes from the kills you already made,
      // so they need to be as findable as the prey is.
      if (!h.alive) {
        if (!h.feedable) continue
        c.strokeStyle = '#8e1b1b'
        c.lineWidth = 2.5
        c.beginPath()
        c.moveTo(q.x - 4, q.y - 4); c.lineTo(q.x + 4, q.y + 4)
        c.moveTo(q.x + 4, q.y - 4); c.lineTo(q.x - 4, q.y + 4)
        c.stroke()
        continue
      }
      if (h.kind === 'hunter') {
        c.fillStyle = h.alerted ? '#ff4d3d' : '#e0a24a'
        c.beginPath()
        c.moveTo(q.x, q.y - 6)
        c.lineTo(q.x + 5, q.y + 5)
        c.lineTo(q.x - 5, q.y + 5)
        c.closePath()
        c.fill()
      } else {
        c.fillStyle = h.alerted ? '#ffd9a0' : '#9fb08a'
        c.beginPath()
        c.arc(q.x, q.y, 3.6, 0, Math.PI * 2)
        c.fill()
      }
    }

    // Tiger.
    c.fillStyle = '#ffb03a'
    c.beginPath()
    c.moveTo(cx, cx - 8)
    c.lineTo(cx + 6, cx + 6)
    c.lineTo(cx - 6, cx + 6)
    c.closePath()
    c.fill()
  }
}
