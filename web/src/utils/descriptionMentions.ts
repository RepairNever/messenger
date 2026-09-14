import type { TaskListItem, TaskListResponse, TaskUser } from '@/services/http/tasksApi'
import { tasksListTasks, tasksListUsers } from '@/services/http/tasksApi'
import { documentsSearchDocuments, type DocumentSearchResult } from '@/services/http/documentsApi'
import { taskSlugFromPublicId } from '@/services/taskRoute'

export interface DescriptionMentionSuggestion {
  kind: 'user' | 'task' | 'document'
  id: string
  label: string
  subtitle: string
  href: string
  icon: string
  avatarUrl?: string
  flatIndex: number
}

const USER_MENTION_PREFIX = 'msgnr-mention://user/'
const TASK_MENTION_LIMIT = 6
const USER_MENTION_LIMIT = 6
const DOCUMENT_MENTION_LIMIT = 6
const MENTION_BASE_CLASSES = [
  'mention-link',
  'inline-flex',
  'items-center',
  'gap-1',
  'rounded-md',
  'border',
  'px-1.5',
  'py-0.5',
  'font-medium',
  'no-underline',
  'transition-colors',
]
const USER_MENTION_CLASSES = [
  ...MENTION_BASE_CLASSES,
  'border-accent/30',
  'bg-accent/10',
  'text-accent',
  'hover:border-accent/60',
  'hover:bg-accent/15',
  'hover:text-white',
]
const TASK_MENTION_CLASSES = [
  ...MENTION_BASE_CLASSES,
  'border-public_id/25',
  'bg-app-taskIdBg',
  'text-public_id',
  'hover:border-public_id/50',
  'hover:bg-public_id/15',
  'hover:text-white',
]
const DOCUMENT_MENTION_CLASSES = [
  ...MENTION_BASE_CLASSES,
  'border-emerald-400/25',
  'bg-emerald-400/10',
  'text-emerald-200',
  'hover:border-emerald-400/50',
  'hover:bg-emerald-400/15',
  'hover:text-white',
]

let cachedUsers: TaskUser[] | null = null
let cachedUsersPromise: Promise<TaskUser[]> | null = null

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase()
}

function userDisplayName(user: TaskUser): string {
  return user.display_name || user.email
}

function scoreUser(user: TaskUser, query: string): number {
  if (!query) return 0
  const displayName = userDisplayName(user).toLowerCase()
  const email = user.email.toLowerCase()
  if (displayName.startsWith(query)) return 0
  if (email.startsWith(query)) return 1
  if (displayName.includes(query)) return 2
  if (email.includes(query)) return 3
  return 4
}

function filterUsers(users: TaskUser[], query: string, limit: number): TaskUser[] {
  const normalized = normalizeQuery(query)
  const filtered = normalized
    ? users.filter((user) => {
        const displayName = userDisplayName(user).toLowerCase()
        const email = user.email.toLowerCase()
        return displayName.includes(normalized) || email.includes(normalized)
      })
    : users.slice()

  return filtered
    .sort((left, right) => {
      const scoreDiff = scoreUser(left, normalized) - scoreUser(right, normalized)
      if (scoreDiff !== 0) return scoreDiff
      return userDisplayName(left).localeCompare(userDisplayName(right))
    })
    .slice(0, limit)
}

function flattenTaskSearch(groups: { tasks: TaskListItem[] }[]): TaskListItem[] {
  return dedupeTaskSearch(groups.flatMap(group => group.tasks ?? []))
}

function dedupeTaskSearch(tasks: TaskListItem[]): TaskListItem[] {
  const unique = new Map<string, TaskListItem>()
  for (const task of tasks) {
    if (!unique.has(task.id)) {
      unique.set(task.id, task)
    }
  }
  return Array.from(unique.values())
}

function taskSearchResults(response: TaskListResponse): TaskListItem[] {
  if (response.tasks) {
    return dedupeTaskSearch(response.tasks)
  }
  return flattenTaskSearch(response.groups ?? [])
}

function documentSubtitle(document: DocumentSearchResult): string {
  const teamspaceName = document.teamspace_name.trim()
  const snippet = document.snippet.trim()
  if (teamspaceName && snippet) return `${teamspaceName} - ${snippet}`
  return teamspaceName || snippet
}

export function buildUserMentionHref(userId: string): string {
  return `${USER_MENTION_PREFIX}${encodeURIComponent(userId)}`
}

export function parseUserMentionHref(href: string): { userId: string } | null {
  const trimmed = href.trim()
  if (!trimmed.startsWith(USER_MENTION_PREFIX)) return null
  const rawId = trimmed.slice(USER_MENTION_PREFIX.length)
  if (!rawId) return null
  try {
    return { userId: decodeURIComponent(rawId) }
  } catch {
    return null
  }
}

export function buildTaskMentionHref(publicId: string): string {
  return `/tasks/${taskSlugFromPublicId(publicId)}`
}

export function buildTaskMentionLabel(publicId: string, title: string): string {
  const safePublicId = publicId.trim()
  const safeTitle = title.trim()
  return safeTitle ? `@${safePublicId} ${safeTitle}` : `@${safePublicId}`
}

export function buildDocumentMentionHref(documentId: string): string {
  return `/documents/${encodeURIComponent(documentId)}`
}

export function buildDocumentMentionLabel(title: string): string {
  const safeTitle = title.trim()
  return safeTitle ? `@${safeTitle}` : '@Document'
}

export function isTaskMentionHref(href: string): boolean {
  if (typeof window === 'undefined') {
    return href.trim().startsWith('/tasks/')
  }
  try {
    const url = new URL(href.trim(), window.location.href)
    return url.pathname.startsWith('/tasks/')
  } catch {
    return false
  }
}

export function isTaskMentionLabel(label: string): boolean {
  return /^@[a-z][a-z0-9]*-\d+(?:\s|$)/i.test(label.trim())
}

export function isTaskMentionLink(href: string, label: string): boolean {
  return isTaskMentionHref(href) && isTaskMentionLabel(label)
}

export function isDocumentMentionHref(href: string): boolean {
  if (typeof window === 'undefined') {
    const path = href.trim()
    return path.startsWith('/documents/') &&
      !path.startsWith('/documents/teamspaces/') &&
      !path.startsWith('/documents/search')
  }
  try {
    const url = new URL(href.trim(), window.location.href)
    return url.pathname.startsWith('/documents/') &&
      !url.pathname.startsWith('/documents/teamspaces/') &&
      url.pathname !== '/documents/search'
  } catch {
    return false
  }
}

export function isDocumentMentionLabel(label: string): boolean {
  return label.trim().startsWith('@')
}

export function isDocumentMentionLink(href: string, label: string): boolean {
  return isDocumentMentionHref(href) && isDocumentMentionLabel(label)
}

export async function loadDescriptionMentionUsers(): Promise<TaskUser[]> {
  if (cachedUsers) return cachedUsers
  if (cachedUsersPromise) return cachedUsersPromise

  cachedUsersPromise = tasksListUsers()
    .then((users) => {
      cachedUsers = users.slice().sort((left, right) => userDisplayName(left).localeCompare(userDisplayName(right)))
      return cachedUsers
    })
    .finally(() => {
      cachedUsersPromise = null
    })

  return cachedUsersPromise
}

export async function getDescriptionMentionUser(userId: string): Promise<TaskUser | null> {
  const users = await loadDescriptionMentionUsers()
  return users.find(user => user.id === userId) ?? null
}

export async function warmDescriptionMentionUsersCache(): Promise<void> {
  await loadDescriptionMentionUsers()
}

export async function searchDescriptionMentionSuggestions(query: string): Promise<DescriptionMentionSuggestion[]> {
  const normalized = query.trim()
  const [users, taskResponse, documents] = await Promise.all([
    loadDescriptionMentionUsers(),
    tasksListTasks({
      search: normalized || undefined,
      include_subtasks: true,
      page_size: TASK_MENTION_LIMIT,
      sort_by: 'updated_at',
      sort_order: 'desc',
    }),
    normalized ? documentsSearchDocuments(normalized) : Promise.resolve([]),
  ])

  const userItems = filterUsers(users, normalized, USER_MENTION_LIMIT).map((user, index) => ({
    kind: 'user' as const,
    id: user.id,
    label: `@${userDisplayName(user)}`,
    subtitle: user.email,
    href: buildUserMentionHref(user.id),
    icon: '@',
    avatarUrl: user.avatar_url,
    flatIndex: index,
  }))

  const taskItems = taskSearchResults(taskResponse).map((task, index) => ({
    kind: 'task' as const,
    id: task.id,
    label: buildTaskMentionLabel(task.public_id, task.title),
    subtitle: task.title,
    href: buildTaskMentionHref(task.public_id),
    icon: '#',
    flatIndex: userItems.length + index,
  }))

  const documentItems = documents.slice(0, DOCUMENT_MENTION_LIMIT).map((document, index) => ({
    kind: 'document' as const,
    id: document.id,
    label: buildDocumentMentionLabel(document.title),
    subtitle: documentSubtitle(document),
    href: buildDocumentMentionHref(document.id),
    icon: 'D',
    flatIndex: userItems.length + taskItems.length + index,
  }))

  return [...userItems, ...taskItems, ...documentItems]
}

export function decorateDescriptionMentionAnchors(root: ParentNode) {
  const anchors = Array.from(root.querySelectorAll('a[href]'))
  for (const anchor of anchors) {
    if (!(anchor instanceof HTMLAnchorElement)) continue
    const href = anchor.getAttribute('href') ?? ''
    const label = anchor.textContent ?? ''

    anchor.classList.remove(...USER_MENTION_CLASSES, ...TASK_MENTION_CLASSES, ...DOCUMENT_MENTION_CLASSES)
    delete anchor.dataset.descriptionMentionKind
    delete anchor.dataset.userId

    const userMention = parseUserMentionHref(href)
    if (userMention) {
      anchor.dataset.descriptionMentionKind = 'user'
      anchor.dataset.userId = userMention.userId
      anchor.classList.add(...USER_MENTION_CLASSES)
      continue
    }

    if (isTaskMentionLink(href, label)) {
      anchor.dataset.descriptionMentionKind = 'task'
      anchor.classList.add(...TASK_MENTION_CLASSES)
      continue
    }

    if (isDocumentMentionLink(href, label)) {
      anchor.dataset.descriptionMentionKind = 'document'
      anchor.classList.add(...DOCUMENT_MENTION_CLASSES)
    }
  }
}

export function decorateDescriptionMentionHtml(html: string): string {
  if (typeof document === 'undefined') return html
  const root = document.createElement('div')
  root.innerHTML = html
  decorateDescriptionMentionAnchors(root)
  return root.innerHTML
}

export function markdownContainsUserMention(markdown: string): boolean {
  return markdown.includes(USER_MENTION_PREFIX)
}

export function resetDescriptionMentionCacheForTests() {
  cachedUsers = null
  cachedUsersPromise = null
}
