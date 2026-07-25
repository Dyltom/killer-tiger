/** Keyboard + pointer-lock mouse input. */

export class Input {
  private down = new Set<string>()
  private pressedThisFrame = new Set<string>()
  /** Accumulated mouse delta since last consume(). */
  mouseDX = 0
  mouseDY = 0
  mouse0 = false
  mouse1 = false
  private mouse0Edge = false
  private mouse1Edge = false

  locked = false
  onLockChange: ((locked: boolean) => void) | null = null
  private el: HTMLElement

  /**
   * When set, attacks register without pointer lock. Embedded webviews can't
   * grab the pointer, so this keeps the game drivable for automated checks.
   */
  nolock = false

  constructor(el: HTMLElement) {
    this.el = el
    addEventListener('keydown', this.onKeyDown)
    addEventListener('keyup', this.onKeyUp)
    addEventListener('mousedown', this.onMouseDown)
    addEventListener('mouseup', this.onMouseUp)
    addEventListener('mousemove', this.onMouseMove)
    document.addEventListener('pointerlockchange', this.onPointerLockChange)
    addEventListener('blur', this.onBlur)
    // Suppress the context menu so right-click can be the bite.
    el.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  requestLock() {
    if (!this.locked) void this.el.requestPointerLock()
  }
  releaseLock() {
    if (this.locked) document.exitPointerLock()
  }

  private onPointerLockChange = () => {
    this.locked = document.pointerLockElement === this.el
    if (!this.locked) {
      this.down.clear()
      this.mouse0 = this.mouse1 = false
    }
    this.onLockChange?.(this.locked)
  }

  private onBlur = () => {
    this.down.clear()
    this.mouse0 = this.mouse1 = false
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return
    // Space would otherwise scroll / re-trigger the focused button.
    if (e.code === 'Space' || e.code === 'Tab') e.preventDefault()
    this.down.add(e.code)
    this.pressedThisFrame.add(e.code)
  }
  private onKeyUp = (e: KeyboardEvent) => {
    this.down.delete(e.code)
  }

  private onMouseDown = (e: MouseEvent) => {
    if (!this.locked && !this.nolock) return
    if (e.button === 0) { this.mouse0 = true; this.mouse0Edge = true }
    if (e.button === 2) { this.mouse1 = true; this.mouse1Edge = true }
  }
  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.mouse0 = false
    if (e.button === 2) this.mouse1 = false
  }
  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return
    this.mouseDX += e.movementX
    this.mouseDY += e.movementY
  }

  held(code: string): boolean {
    return this.down.has(code)
  }
  /** True only on the frame the key went down. */
  pressed(code: string): boolean {
    return this.pressedThisFrame.has(code)
  }
  clickedPrimary(): boolean {
    return this.mouse0Edge
  }
  clickedSecondary(): boolean {
    return this.mouse1Edge
  }

  /** Movement intent in local space: x = strafe (+right), z = forward (+fwd). */
  moveAxis(): { x: number; z: number } {
    let x = 0
    let z = 0
    if (this.held('KeyW') || this.held('ArrowUp')) z += 1
    if (this.held('KeyS') || this.held('ArrowDown')) z -= 1
    if (this.held('KeyD') || this.held('ArrowRight')) x += 1
    if (this.held('KeyA') || this.held('ArrowLeft')) x -= 1
    const len = Math.hypot(x, z)
    if (len > 1) { x /= len; z /= len }
    return { x, z }
  }

  /** Call once at the end of each frame. */
  endFrame() {
    this.pressedThisFrame.clear()
    this.mouse0Edge = false
    this.mouse1Edge = false
    this.mouseDX = 0
    this.mouseDY = 0
  }
}
