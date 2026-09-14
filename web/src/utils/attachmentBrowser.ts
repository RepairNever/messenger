function focusWindow(win: Window) {
  try {
    win.focus()
  } catch {
    // Ignore browsers that restrict programmatic focus.
  }
}

function detachOpener(win: Window) {
  try {
    win.opener = null
  } catch {
    // Ignore browsers that expose opener as read-only.
  }
}

function openNewTab(target: string): Window {
  const opened = window.open(target, '_blank')
  if (!opened) {
    throw new Error('Popup blocked. Allow pop-ups to open attachments.')
  }

  detachOpener(opened)
  focusWindow(opened)
  return opened
}

export function openHrefInBrowser(href: string): void {
  const opened = openNewTab(href)
  focusWindow(opened)
}

export async function openBlobInBrowser(loadBlob: () => Promise<Blob>): Promise<void> {
  const opened = openNewTab('about:blank')

  try {
    const blob = await loadBlob()
    const url = URL.createObjectURL(blob)

    opened.location.replace(url)
    focusWindow(opened)

    window.setTimeout(() => {
      URL.revokeObjectURL(url)
    }, 1_000)
  } catch (error) {
    opened.close()
    throw error
  }
}
