import assert from 'node:assert/strict'

export async function captureSidebarRows(application, sessions, stage, captureDetails = false) {
  const captured = await application.page.evaluate((details) => {
    const list = document.querySelector('[data-session-list]')
    const viewport = list.getBoundingClientRect()
    const boundsOf = (element) => {
      const bounds = element.getBoundingClientRect()
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    }
    const rows = [...list.querySelectorAll('[data-session-row]')].map((element) => {
      const bounds = boundsOf(element)
      const ancestors = []
      for (
        let parent = element.parentElement;
        parent && parent !== list;
        parent = parent.parentElement
      ) {
        if (
          details &&
          (parent.hasAttribute('data-windowed-index') || parent.hasAttribute('data-windowed-list'))
        ) {
          ancestors.push({
            index: parent.getAttribute('data-windowed-index'),
            transform: getComputedStyle(parent).transform,
            bounds: boundsOf(parent)
          })
        }
      }
      const title = element.textContent?.match(/Scale \d+ (?:pi|prime) \d{4}/)?.[0]
      return {
        title,
        focused: document.activeElement === element,
        visible: bounds.y + bounds.height > viewport.top && bounds.y < viewport.bottom,
        bounds,
        ancestors,
        html: details ? element.outerHTML : undefined,
        parentHtml: details ? element.parentElement.outerHTML : undefined
      }
    })
    // Distant rows compare DOM hit testing with pixels in the 1440 × 900 viewport.
    const paintPoints = (
      details
        ? [
            { x: 90, y: 239 },
            { x: 90, y: 739 }
          ]
        : []
    ).map((point) => {
      const elements = document.elementsFromPoint(point.x, point.y)
      const row = elements.map((element) => element.closest('[data-session-row]')).find(Boolean)
      return { ...point, title: row?.textContent, bounds: row ? boundsOf(row) : null }
    })
    return { rows, paintPoints, scrollTop: list.scrollTop, scrollHeight: list.scrollHeight }
  }, captureDetails)
  const knownPaths = new Map(sessions.map((session) => [session.name, session.path]))
  return {
    operation: 'sidebar-rows',
    stage,
    ...captured,
    rows: captured.rows.map((row) => ({
      ...row,
      fixturePath: row.title ? knownPaths.get(row.title) : undefined
    }))
  }
}

export function assertUniqueVisibleSessions(snapshot) {
  const visible = snapshot.rows.filter((row) => row.visible && row.title)
  const identities = visible.map((row) => row.fixturePath ?? row.title)
  const duplicates = identities.filter((identity, index) => identities.indexOf(identity) !== index)
  assert.equal(duplicates.length, 0, `Duplicate visible sessions: ${duplicates.join(', ')}`)
}
