export type AttachmentOwnerKind = 'task' | 'document'
export type AttachmentTokenOwnerKind = AttachmentOwnerKind | 'task-staged'

export interface AttachmentUrlParts {
  ownerKind: AttachmentTokenOwnerKind
  ownerId: string
  attachmentId: string
}

export interface AttachmentToken extends AttachmentUrlParts {
  kind: 'image' | 'file'
  fileName: string
  url: string
}

export type AttachmentMarkdownBlock =
  | { type: 'markdown'; content: string }
  | { type: 'attachment'; token: AttachmentToken }

const ATTACHMENT_URL_PREFIX = 'msgnr-attachment://'
const STAGED_ATTACHMENT_URL_PREFIX = 'msgnr-staged-attachment://'
const ATTACHMENT_URL_RE = /^msgnr-attachment:\/\/(task|document)\/([^/]+)\/([^/\s)]+)$/
const STAGED_TASK_ATTACHMENT_URL_RE = /^msgnr-staged-attachment:\/\/task\/([^/\s)]+)$/
const ATTACHMENT_IMAGE_LINE_RE = /^!\[((?:\\.|[^\]])*)\]\(((?:msgnr-attachment|msgnr-staged-attachment):\/\/[^)\s]+)\)\s*$/
const ATTACHMENT_FILE_LINE_RE = /^\[((?:\\.|[^\]])*)\]\(((?:msgnr-attachment|msgnr-staged-attachment):\/\/[^)\s]+)\)\s*$/
const STAGED_TASK_ATTACHMENT_ID_RE = /msgnr-staged-attachment:\/\/task\/([^/\s)]+)/g

function escapeMarkdownLabel(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\]/g, '\\]')
    .replace(/\[/g, '\\[')
    .replace(/\n/g, ' ')
}

function unescapeMarkdownLabel(value: string): string {
  return value
    .replace(/\\\]/g, ']')
    .replace(/\\\[/g, '[')
    .replace(/\\\\/g, '\\')
}

export function buildAttachmentUrl(ownerKind: AttachmentOwnerKind, ownerId: string, attachmentId: string): string {
  return `${ATTACHMENT_URL_PREFIX}${ownerKind}/${ownerId}/${attachmentId}`
}

export function buildTaskStagedAttachmentUrl(attachmentId: string): string {
  return `${STAGED_ATTACHMENT_URL_PREFIX}task/${attachmentId}`
}

export function buildAttachmentMarkdown(
  ownerKind: AttachmentOwnerKind,
  ownerId: string,
  attachmentId: string,
  fileName: string,
  mimeType: string,
): string {
  const label = escapeMarkdownLabel(fileName)
  const url = buildAttachmentUrl(ownerKind, ownerId, attachmentId)
  return mimeType.startsWith('image/')
    ? `![${label}](${url})`
    : `[${label}](${url})`
}

export function buildTaskStagedAttachmentMarkdown(attachmentId: string, fileName: string, mimeType: string): string {
  const label = escapeMarkdownLabel(fileName)
  const url = buildTaskStagedAttachmentUrl(attachmentId)
  return mimeType.startsWith('image/')
    ? `![${label}](${url})`
    : `[${label}](${url})`
}

export function parseAttachmentUrl(value: string): AttachmentUrlParts | null {
  let match = value.match(ATTACHMENT_URL_RE)
  if (match) {
    const [, ownerKind, ownerId, attachmentId] = match
    if (ownerKind !== 'task' && ownerKind !== 'document') return null
    return {
      ownerKind,
      ownerId,
      attachmentId,
    }
  }

  match = value.match(STAGED_TASK_ATTACHMENT_URL_RE)
  if (!match) return null
  const [, attachmentId] = match
  return {
    ownerKind: 'task-staged',
    ownerId: '',
    attachmentId,
  }
}

export function extractTaskStagedAttachmentIds(markdown: string | null | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of (markdown ?? '').matchAll(STAGED_TASK_ATTACHMENT_ID_RE)) {
    const id = match[1]
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export function parseAttachmentTokenLine(value: string): AttachmentToken | null {
  const trimmed = value.trim()
  let match = trimmed.match(ATTACHMENT_IMAGE_LINE_RE)
  let kind: AttachmentToken['kind'] = 'image'
  if (!match) {
    match = trimmed.match(ATTACHMENT_FILE_LINE_RE)
    kind = 'file'
  }
  if (!match) return null

  const [, rawLabel, url] = match
  const parts = parseAttachmentUrl(url)
  if (!parts) return null
  return {
    ...parts,
    kind,
    url,
    fileName: unescapeMarkdownLabel(rawLabel),
  }
}

export function splitMarkdownWithAttachmentBlocks(markdown: string | null | undefined): AttachmentMarkdownBlock[] {
  const input = markdown ?? ''
  if (!input) return []

  const lines = input.split('\n')
  const blocks: AttachmentMarkdownBlock[] = []
  let markdownBuffer: string[] = []

  const flushMarkdown = () => {
    if (markdownBuffer.length === 0) return
    blocks.push({
      type: 'markdown',
      content: markdownBuffer.join('\n'),
    })
    markdownBuffer = []
  }

  for (const line of lines) {
    const token = parseAttachmentTokenLine(line)
    if (token) {
      flushMarkdown()
      blocks.push({ type: 'attachment', token })
      continue
    }
    markdownBuffer.push(line)
  }

  flushMarkdown()
  return blocks
}
