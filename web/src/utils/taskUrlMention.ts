import {
  isUuidTaskRouteValue,
  taskPublicIdFromSlug,
  taskSlugFromPublicId,
} from '@/services/taskRoute'

const TASK_ROUTE_PATH_RE = /^\/tasks\/([a-z]+-\d+)$/

export interface StandaloneTaskUrlMention {
  publicId: string
  url: string
  start: number
  end: number
}

/**
 * Recognizes the absolute task URL produced by the task-card copy action.
 *
 * `start` and `end` point at only the URL, leaving any pasted surrounding
 * whitespace intact when a caller replaces it with a task mention node.
 */
export function findStandaloneCurrentWorkspaceTaskUrl(
  pastedText: string | null | undefined,
  currentWorkspaceOrigin: string,
): StandaloneTaskUrlMention | null {
  if (typeof pastedText !== 'string' || typeof currentWorkspaceOrigin !== 'string') return null

  const start = pastedText.length - pastedText.trimStart().length
  const end = pastedText.trimEnd().length
  if (start === end) return null

  const url = pastedText.slice(start, end)
  let currentWorkspaceUrl: URL
  let pastedUrl: URL
  try {
    currentWorkspaceUrl = new URL(currentWorkspaceOrigin)
    pastedUrl = new URL(url)
  } catch {
    return null
  }

  if (
    pastedUrl.protocol !== currentWorkspaceUrl.protocol
    || pastedUrl.host !== currentWorkspaceUrl.host
    || pastedUrl.username
    || pastedUrl.password
    || pastedUrl.search
    || pastedUrl.hash
  ) {
    return null
  }

  const routeMatch = pastedUrl.pathname.match(TASK_ROUTE_PATH_RE)
  if (!routeMatch) return null

  const taskSlug = routeMatch[1]
  if (isUuidTaskRouteValue(taskSlug)) return null

  const publicId = taskPublicIdFromSlug(taskSlug)
  const canonicalTaskSlug = taskSlugFromPublicId(publicId)
  if (taskSlug !== canonicalTaskSlug) return null

  const canonicalUrl = new URL(`/tasks/${canonicalTaskSlug}`, currentWorkspaceUrl).toString()
  if (url !== canonicalUrl) return null

  return {
    publicId,
    url,
    start,
    end,
  }
}
