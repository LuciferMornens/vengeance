/**
 * Electron's contextBridge refuses values it has to recurse into about 1000 times ("recursion depth exceeded"),
 * and the renderer would get that error instead of the data. Tool arguments and results are model- or
 * MCP-supplied JSON that can nest arbitrarily, so every payload leaving main is bounded here.
 *
 * Measured on Electron 44: a plain object costs the bridge two recursion steps and an array one, so a chain
 * of 500 objects already fails while 1000 nested arrays pass.
 */

/** Bridge recursion steps a payload may use: below the bridge's 1000, with room for wrappers and leaves. */
export const MAX_BRIDGE_DEPTH = 900

export const TOO_DEEP_PLACEHOLDER = '[nested too deep]'

type Container = Record<string, unknown> | unknown[]

/** Arrays and plain objects; anything else (strings, Uint8Array, Date…) crosses the bridge as a leaf. */
function isContainer(value: unknown): value is Container {
  if (Array.isArray(value)) return true
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function bridgeSteps(container: Container): number {
  return Array.isArray(container) ? 1 : 2
}

/** Whether some container in `value` sits more than `limit` bridge steps deep. Iterative. */
function exceedsBridgeDepth(value: Container, limit: number): boolean {
  const stack: Array<{ container: Container; depth: number }> = [{ container: value, depth: bridgeSteps(value) }]
  while (stack.length > 0) {
    const { container, depth } = stack.pop()!
    if (depth > limit) return true
    if (Array.isArray(container)) {
      for (let i = 0; i < container.length; i++) {
        const child = container[i]
        if (typeof child === 'object' && child !== null && isContainer(child)) {
          stack.push({ container: child, depth: depth + bridgeSteps(child) })
        }
      }
    } else {
      for (const key in container) {
        if (!Object.prototype.hasOwnProperty.call(container, key)) continue
        const child = container[key]
        if (typeof child === 'object' && child !== null && isContainer(child)) {
          stack.push({ container: child, depth: depth + bridgeSteps(child) })
        }
      }
    }
  }
  return false
}

/** Copy of `value` where every container deeper than `limit` bridge steps becomes TOO_DEEP_PLACEHOLDER. Iterative. */
function truncateBridgeDepth(value: Container, limit: number): Container {
  const emptyLike = (container: Container): Container => (Array.isArray(container) ? [] : {})
  const root = emptyLike(value)
  const stack: Array<{ source: Container; target: Container; depth: number }> = [{ source: value, target: root, depth: bridgeSteps(value) }]
  const visitChild = (slots: Record<string, unknown>, key: string | number, child: unknown, depth: number): void => {
    if (typeof child !== 'object' || child === null || !isContainer(child)) {
      slots[key] = child
      return
    }
    const childDepth = depth + bridgeSteps(child)
    if (childDepth > limit) {
      slots[key] = TOO_DEEP_PLACEHOLDER
      return
    }
    const copy = emptyLike(child)
    slots[key] = copy
    stack.push({ source: child, target: copy, depth: childDepth })
  }
  while (stack.length > 0) {
    const { source, target, depth } = stack.pop()!
    const slots = target as Record<string, unknown>
    if (Array.isArray(source)) {
      for (let i = 0; i < source.length; i++) {
        visitChild(slots, i, source[i], depth)
      }
    } else {
      for (const key in source) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue
        visitChild(slots, key, source[key], depth)
      }
    }
  }
  return root
}

/** `value` itself when it fits through the contextBridge, else a copy with its over-deep parts replaced. */
export function limitPayloadDepth<T>(value: T, limit = MAX_BRIDGE_DEPTH): T {
  if (!isContainer(value) || !exceedsBridgeDepth(value, limit)) return value
  return truncateBridgeDepth(value, limit) as T
}
