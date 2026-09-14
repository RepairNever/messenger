import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'
import type { DocumentItem } from '@/services/http/documentsApi'
import type { Task } from '@/services/http/tasksApi'
import { fetchOwnedAttachmentBlob } from '@/services/http/attachmentOwnersApi'
import { splitMarkdownWithAttachmentBlocks, type AttachmentToken } from '@/utils/attachmentMarkdown'
import { renderTaskMarkdownToHtml } from '@/utils/taskMarkdown'

const A4_WIDTH_PT = 595.28
const A4_HEIGHT_PT = 841.89
const EXPORT_WIDTH_PX = 794
const PDF_PAGE_MARGIN_PT = 32
const PAGE_BREAK_SEARCH_RADIUS_PX = 48
const MIN_PAGE_SLICE_RATIO = 0.75

export interface TaskPdfExportMarkdownBlock {
  kind: 'markdown'
  html: string
}

export interface TaskPdfExportImageBlock {
  kind: 'image'
  fileName: string
  src: string
}

export interface TaskPdfExportFileBlock {
  kind: 'file'
  fileName: string
}

export type TaskPdfExportBlock =
  | TaskPdfExportMarkdownBlock
  | TaskPdfExportImageBlock
  | TaskPdfExportFileBlock

export interface TaskPdfExportDocument {
  fileName: string
  header: string
  blocks: TaskPdfExportBlock[]
}

export interface MarkdownPdfExportSource {
  header: string
  markdown: string | null
  fileName: string
}

export function buildTaskPdfFileName(task: Pick<Task, 'public_id'>): string {
  const publicId = task.public_id?.trim() || 'task'
  return `${publicId}.pdf`
}

export function buildDocumentPdfFileName(document: Pick<DocumentItem, 'title'>): string {
  const sanitized = sanitizePdfFileNameStem(document.title)
  return `${sanitized}.pdf`
}

function buildTaskPdfHeader(task: Pick<Task, 'public_id' | 'title'>): string {
  return `${task.public_id} ${task.title}`.trim()
}

function buildDocumentPdfHeader(document: Pick<DocumentItem, 'title'>): string {
  return document.title.trim() || 'Document'
}

function sanitizePdfFileNameStem(value: string | null | undefined): string {
  const sanitized = (value ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
  return sanitized || 'document'
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
        return
      }
      reject(new Error('Failed to read attachment data.'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read attachment data.'))
    reader.readAsDataURL(blob)
  })
}

async function buildAttachmentBlock(token: AttachmentToken): Promise<TaskPdfExportBlock> {
  if (token.kind !== 'image') {
    return {
      kind: 'file',
      fileName: token.fileName,
    }
  }
  if (token.ownerKind === 'task-staged') {
    return {
      kind: 'file',
      fileName: token.fileName,
    }
  }

  try {
    const blob = await fetchOwnedAttachmentBlob(token.ownerKind, token.ownerId, token.attachmentId)
    return {
      kind: 'image',
      fileName: token.fileName,
      src: await blobToDataUrl(blob),
    }
  } catch {
    return {
      kind: 'file',
      fileName: token.fileName,
    }
  }
}

export async function buildMarkdownPdfExportDocument(
  source: MarkdownPdfExportSource,
): Promise<TaskPdfExportDocument> {
  const blocks: TaskPdfExportBlock[] = []

  for (const block of splitMarkdownWithAttachmentBlocks(source.markdown ?? '')) {
    if (block.type === 'markdown') {
      if (block.content.trim() === '') continue
      blocks.push({
        kind: 'markdown',
        html: renderTaskMarkdownToHtml(block.content),
      })
      continue
    }
    blocks.push(await buildAttachmentBlock(block.token))
  }

  return {
    fileName: source.fileName,
    header: source.header,
    blocks,
  }
}

export async function buildTaskPdfExportDocument(
  task: Pick<Task, 'public_id' | 'title' | 'description'>,
): Promise<TaskPdfExportDocument> {
  return buildMarkdownPdfExportDocument({
    fileName: buildTaskPdfFileName(task),
    header: buildTaskPdfHeader(task),
    markdown: task.description,
  })
}

export async function buildDocumentPdfExportDocument(
  document: Pick<DocumentItem, 'title' | 'content_markdown'>,
): Promise<TaskPdfExportDocument> {
  return buildMarkdownPdfExportDocument({
    fileName: buildDocumentPdfFileName(document),
    header: buildDocumentPdfHeader(document),
    markdown: document.content_markdown,
  })
}

function buildStyles(): string {
  return `
    .task-pdf-export {
      background: #ffffff !important;
      color: #000000 !important;
      width: ${EXPORT_WIDTH_PX}px;
      box-sizing: border-box;
      padding: 56px;
      font-family: Arial, Helvetica, sans-serif;
      line-height: 1.5;
    }
    .task-pdf-export * {
      box-sizing: border-box;
      color: #000000 !important;
    }
    .task-pdf-export__header {
      margin: 0 0 32px;
      font-size: 26px;
      font-weight: 700;
      line-height: 1.25;
      color: #000000 !important;
      word-break: break-word;
    }
    .task-pdf-export__section {
      margin-top: 18px;
    }
    .task-pdf-export__attachment {
      margin-top: 16px;
      border: 1px solid #000000 !important;
      padding: 10px 12px;
      font-size: 14px;
      color: #000000 !important;
      background: #ffffff !important;
      word-break: break-word;
    }
    .task-pdf-export__image {
      margin-top: 18px;
    }
    .task-pdf-export__image img {
      display: block;
      width: 100%;
      height: auto;
      border: 1px solid #000000 !important;
      background: #ffffff !important;
    }
    .task-pdf-export__image figcaption {
      margin-top: 8px;
      font-size: 12px;
      color: #000000 !important;
    }
    .task-pdf-export .markdown-body {
      color: #000000 !important;
      font-size: 14px;
      line-height: 1.6;
      word-break: break-word;
    }
    .task-pdf-export .markdown-body p,
    .task-pdf-export .markdown-body ul,
    .task-pdf-export .markdown-body ol,
    .task-pdf-export .markdown-body blockquote,
    .task-pdf-export .markdown-body pre,
    .task-pdf-export .markdown-body h1,
    .task-pdf-export .markdown-body h2,
    .task-pdf-export .markdown-body h3,
    .task-pdf-export .markdown-body h4,
    .task-pdf-export .markdown-body h5,
    .task-pdf-export .markdown-body h6,
    .task-pdf-export .markdown-body table {
      margin: 0 0 12px;
      color: inherit;
    }
    .task-pdf-export .markdown-body h1 { font-size: 24px; }
    .task-pdf-export .markdown-body h2 { font-size: 20px; }
    .task-pdf-export .markdown-body h3 { font-size: 18px; }
    .task-pdf-export .markdown-body h4,
    .task-pdf-export .markdown-body h5,
    .task-pdf-export .markdown-body h6 { font-size: 16px; }
    .task-pdf-export .markdown-body ul,
    .task-pdf-export .markdown-body ol {
      margin-left: 0;
      padding-left: 0;
      list-style: none;
    }
    .task-pdf-export .task-pdf-export__list {
      margin: 0 0 12px;
      padding: 0;
      list-style: none;
    }
    .task-pdf-export .task-pdf-export__list-item {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: start;
      column-gap: 8px;
      margin: 0 0 6px;
      list-style: none;
    }
    .task-pdf-export .task-pdf-export__list-marker {
      min-width: 20px;
      color: #000000 !important;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .task-pdf-export .task-pdf-export__list--unordered > .task-pdf-export__list-item > .task-pdf-export__list-marker {
      font-size: 16px;
      line-height: 1.45;
    }
    .task-pdf-export .task-pdf-export__list-content {
      min-width: 0;
      line-height: 1.6;
    }
    .task-pdf-export .task-pdf-export__list-content > ul,
    .task-pdf-export .task-pdf-export__list-content > ol {
      margin-top: 6px;
      margin-bottom: 0;
      padding-left: 20px;
    }
    .task-pdf-export .markdown-body li[data-type='taskItem'] {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      list-style: none;
      margin-bottom: 6px;
    }
    .task-pdf-export .markdown-body li[data-type='taskItem'] > label {
      margin-top: 2px;
      display: inline-flex;
      align-items: flex-start;
      gap: 8px;
    }
    .task-pdf-export .markdown-body li[data-type='taskItem'] > label > input[type='checkbox'] {
      width: 14px;
      height: 14px;
      accent-color: #000000;
    }
    .task-pdf-export .markdown-body li[data-type='taskItem'] > label > span {
      display: none;
    }
    .task-pdf-export .markdown-body blockquote {
      border-left: 4px solid #000000;
      padding: 0px 6px 12px;
      background: #f5f5f5;
    }
    .task-pdf-export .markdown-body code {
      display: inline-block !important;
      position: relative;
      top: 1px;
      vertical-align: baseline !important;
      font-family: "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 0.95em;
      line-height: 1.2 !important;
      background: #f5f5f5;
      border: 1px solid #d4d4d4;
      padding: 0px 6px 12px;
      border-radius: 6px;
    }
    .task-pdf-export .markdown-body pre {
      display: block !important;
      position: relative;
      margin: 6px 0 14px !important;
      font-family: "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 14px;
      line-height: 1.55;
      background: #f1f1f1;
      border: 1px solid #000000;
      border-radius: 10px;
      padding: 16px 16px 14px;
      overflow: hidden;
      white-space: break-spaces;
      word-break: normal !important;
      overflow-wrap: normal !important;
      box-shadow: none !important;
      transform: none !important;
      vertical-align: top !important;
    }
    .task-pdf-export .markdown-body pre[data-language] {
      padding-top: 26px;
    }
    .task-pdf-export .markdown-body pre[data-language]::before {
      content: attr(data-language);
      position: absolute;
      top: 8px;
      right: 12px;
      color: #555555;
      font-size: 9px;
      font-weight: 700;
      line-height: 1;
      text-transform: uppercase;
    }
    .task-pdf-export .markdown-body pre code {
      display: block !important;
      position: static !important;
      top: auto !important;
      margin: 0 !important;
      vertical-align: baseline !important;
      font-family: inherit !important;
      font-size: inherit !important;
      line-height: inherit !important;
      padding: 0;
      border: 0;
      background: transparent;
      white-space: inherit !important;
      word-break: inherit !important;
      overflow-wrap: inherit !important;
    }
    .task-pdf-export .markdown-body a {
      color: #000000;
      text-decoration: underline;
    }
    .task-pdf-export .markdown-body table {
      width: 100%;
      table-layout: fixed;
      border-collapse: collapse !important;
      border-spacing: 0 !important;
      background: #ffffff !important;
      font-size: 13px;
    }
    .task-pdf-export .markdown-body th,
    .task-pdf-export .markdown-body td {
      border: 1px solid #000000 !important;
      padding: 8px 10px;
      text-align: left;
      vertical-align: top;
      white-space: normal !important;
      overflow-wrap: anywhere;
      background: #ffffff !important;
      color: #000000 !important;
    }
    .task-pdf-export .markdown-body th {
      font-weight: 700;
      background: #f1f1f1 !important;
    }
    .task-pdf-export .markdown-body tbody,
    .task-pdf-export .markdown-body thead,
    .task-pdf-export .markdown-body tr {
      background: #ffffff !important;
      color: #000000 !important;
    }
    .task-pdf-export .markdown-body blockquote,
    .task-pdf-export .markdown-body blockquote *,
    .task-pdf-export .markdown-body code,
    .task-pdf-export .markdown-body code *,
    .task-pdf-export .markdown-body pre,
    .task-pdf-export .markdown-body pre *,
    .task-pdf-export .markdown-body a,
    .task-pdf-export .markdown-body a * {
      color: #000000 !important;
    }
    .task-pdf-export .markdown-body code {
      background: #f1f1f1 !important;
      border: 1px solid #cfcfcf !important;
    }
    .task-pdf-export .markdown-body pre {
      background: #f1f1f1 !important;
      border: 1px solid #000000 !important;
      color: #000000 !important;
    }
    .task-pdf-export .markdown-body pre code {
      background: transparent !important;
      border: 0 !important;
      color: #000000 !important;
      border-radius: 0 !important;
    }
    .task-pdf-export .markdown-body .hljs-comment,
    .task-pdf-export .markdown-body .hljs-quote {
      color: #666666 !important;
      font-style: italic;
    }
    .task-pdf-export .markdown-body .hljs-keyword,
    .task-pdf-export .markdown-body .hljs-selector-tag,
    .task-pdf-export .markdown-body .hljs-subst {
      color: #004f9e !important;
      font-weight: 700;
    }
    .task-pdf-export .markdown-body .hljs-string,
    .task-pdf-export .markdown-body .hljs-doctag,
    .task-pdf-export .markdown-body .hljs-regexp {
      color: #116329 !important;
    }
    .task-pdf-export .markdown-body .hljs-number,
    .task-pdf-export .markdown-body .hljs-literal,
    .task-pdf-export .markdown-body .hljs-symbol,
    .task-pdf-export .markdown-body .hljs-bullet {
      color: #8a4b00 !important;
    }
    .task-pdf-export .markdown-body .hljs-title,
    .task-pdf-export .markdown-body .hljs-title.function_,
    .task-pdf-export .markdown-body .hljs-function .hljs-title {
      color: #005f73 !important;
      font-weight: 700;
    }
    .task-pdf-export .markdown-body .hljs-title.class_,
    .task-pdf-export .markdown-body .hljs-type,
    .task-pdf-export .markdown-body .hljs-class .hljs-title {
      color: #5f3dc4 !important;
      font-weight: 700;
    }
    .task-pdf-export .markdown-body .hljs-attr,
    .task-pdf-export .markdown-body .hljs-attribute,
    .task-pdf-export .markdown-body .hljs-property,
    .task-pdf-export .markdown-body .hljs-variable,
    .task-pdf-export .markdown-body .hljs-template-variable {
      color: #9d174d !important;
    }
    .task-pdf-export .markdown-body .hljs-built_in,
    .task-pdf-export .markdown-body .hljs-builtin-name,
    .task-pdf-export .markdown-body .hljs-name {
      color: #0369a1 !important;
    }
    .task-pdf-export .markdown-body .hljs-operator,
    .task-pdf-export .markdown-body .hljs-punctuation,
    .task-pdf-export .markdown-body .hljs-params {
      color: #222222 !important;
    }
    .task-pdf-export .markdown-body .hljs-meta,
    .task-pdf-export .markdown-body .hljs-section,
    .task-pdf-export .markdown-body .hljs-selector-id,
    .task-pdf-export .markdown-body .hljs-selector-class {
      color: #9f1239 !important;
    }
    .task-pdf-export .markdown-body .hljs-addition {
      color: #116329 !important;
    }
    .task-pdf-export .markdown-body .hljs-deletion {
      color: #991b1b !important;
    }
  `
}

function normalizeRenderedLists(root: HTMLElement) {
  const lists = Array.from(root.querySelectorAll('ol, ul')).reverse()

  for (const list of lists) {
    const listElement = list as HTMLOListElement | HTMLUListElement
    if (listElement.dataset.type === 'taskList') continue

    const ordered = listElement.tagName === 'OL'
    listElement.classList.add('task-pdf-export__list')
    listElement.classList.toggle('task-pdf-export__list--ordered', ordered)
    listElement.classList.toggle('task-pdf-export__list--unordered', !ordered)

    const items = Array.from(listElement.children).filter((child): child is HTMLLIElement => child.tagName === 'LI')
    let index = 1

    for (const item of items) {
      if (item.dataset.type === 'taskItem' || item.dataset.pdfListNormalized === 'true') {
        index += 1
        continue
      }

      item.dataset.pdfListNormalized = 'true'
      item.classList.add('task-pdf-export__list-item')

      const marker = document.createElement('span')
      marker.className = 'task-pdf-export__list-marker'
      marker.textContent = ordered ? `${index}.` : '•'

      const content = document.createElement('div')
      content.className = 'task-pdf-export__list-content'
      const existingNodes = Array.from(item.childNodes)
      for (const node of existingNodes) {
        content.appendChild(node)
      }

      item.replaceChildren(marker, content)
      index += 1
    }
  }
}

function renderTaskPdfExportRoot(documentModel: TaskPdfExportDocument): {
  host: HTMLElement
  captureTarget: HTMLElement
} {
  const root = document.createElement('div')
  root.setAttribute('data-testid', 'task-pdf-export-root')
  root.style.position = 'fixed'
  root.style.left = '0'
  root.style.top = '0'
  root.style.zIndex = '-1'
  root.style.pointerEvents = 'none'

  const container = document.createElement('div')
  container.className = 'task-pdf-export'

  const style = document.createElement('style')
  style.textContent = buildStyles()
  container.appendChild(style)

  const header = document.createElement('h1')
  header.className = 'task-pdf-export__header'
  header.textContent = documentModel.header
  container.appendChild(header)

  for (const block of documentModel.blocks) {
    if (block.kind === 'markdown') {
      const section = document.createElement('div')
      section.className = 'task-pdf-export__section markdown-body'
      section.innerHTML = block.html
      normalizeRenderedLists(section)
      container.appendChild(section)
      continue
    }

    if (block.kind === 'image') {
      const figure = document.createElement('figure')
      figure.className = 'task-pdf-export__image'

      const img = document.createElement('img')
      img.src = block.src
      img.alt = block.fileName
      figure.appendChild(img)

      const caption = document.createElement('figcaption')
      caption.textContent = block.fileName
      figure.appendChild(caption)
      container.appendChild(figure)
      continue
    }

    const file = document.createElement('div')
    file.className = 'task-pdf-export__attachment'
    file.textContent = `Attachment: ${block.fileName}`
    container.appendChild(file)
  }

  root.appendChild(container)
  return {
    host: root,
    captureTarget: container,
  }
}

async function waitForImages(root: HTMLElement): Promise<void> {
  const images = Array.from(root.querySelectorAll('img'))
  await Promise.all(images.map(image => {
    if (image.complete) return Promise.resolve()
    return new Promise<void>((resolve) => {
      image.addEventListener('load', () => resolve(), { once: true })
      image.addEventListener('error', () => resolve(), { once: true })
    })
  }))
}

function renderCanvasPage(canvas: HTMLCanvasElement, offsetY: number, sliceHeight: number): HTMLCanvasElement {
  const pageCanvas = document.createElement('canvas')
  pageCanvas.width = canvas.width
  pageCanvas.height = sliceHeight
  const ctx = pageCanvas.getContext('2d')
  if (!ctx) {
    throw new Error('Failed to prepare a PDF page.')
  }
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height)
  ctx.drawImage(
    canvas,
    0,
    offsetY,
    canvas.width,
    sliceHeight,
    0,
    0,
    pageCanvas.width,
    pageCanvas.height,
  )
  return pageCanvas
}

export function chooseNearestWhitespaceRow(
  rowInkScores: readonly number[],
  targetRow: number,
  minRow: number,
  maxRow: number,
): number {
  const start = Math.max(0, Math.min(minRow, rowInkScores.length - 1))
  const end = Math.max(start, Math.min(maxRow, rowInkScores.length - 1))
  const clampedTarget = Math.max(start, Math.min(targetRow, end))

  let bestRow = clampedTarget
  let bestScore = rowInkScores[clampedTarget] ?? Number.POSITIVE_INFINITY
  let bestDistance = 0

  for (let row = start; row <= end; row += 1) {
    const score = rowInkScores[row] ?? Number.POSITIVE_INFINITY
    const distance = Math.abs(row - clampedTarget)
    if (score < bestScore || (score === bestScore && distance < bestDistance)) {
      bestRow = row
      bestScore = score
      bestDistance = distance
    }
  }

  return bestRow
}

function buildCanvasRowInkScores(canvas: HTMLCanvasElement): number[] {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    return []
  }

  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const rowScores = new Array<number>(height).fill(0)

  for (let row = 0; row < height; row += 1) {
    let rowInk = 0
    const rowOffset = row * width * 4
    for (let col = 0; col < width; col += 1) {
      const pixelOffset = rowOffset + (col * 4)
      const alpha = data[pixelOffset + 3] / 255
      if (alpha === 0) continue

      const r = data[pixelOffset]
      const g = data[pixelOffset + 1]
      const b = data[pixelOffset + 2]
      rowInk += ((255 * 3) - (r + g + b)) * alpha
    }
    rowScores[row] = rowInk
  }

  return rowScores
}

function computePageSliceHeight(
  rowInkScores: readonly number[],
  canvasHeight: number,
  offsetY: number,
  targetSliceHeight: number,
): number {
  const remainingHeight = canvasHeight - offsetY
  if (remainingHeight <= targetSliceHeight) {
    return remainingHeight
  }

  const minimumBreakRow = offsetY + Math.max(1, Math.floor(targetSliceHeight * MIN_PAGE_SLICE_RATIO))
  const desiredBreakRow = offsetY + targetSliceHeight
  const maximumBreakRow = Math.min(
    canvasHeight - 1,
    desiredBreakRow + PAGE_BREAK_SEARCH_RADIUS_PX,
  )
  const searchStart = Math.max(minimumBreakRow, desiredBreakRow - PAGE_BREAK_SEARCH_RADIUS_PX)
  const breakRow = chooseNearestWhitespaceRow(rowInkScores, desiredBreakRow, searchStart, maximumBreakRow)
  return Math.max(1, breakRow - offsetY)
}

function canvasToPdfBlob(canvas: HTMLCanvasElement): Blob {
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'pt',
    format: 'a4',
  })

  const printableWidth = A4_WIDTH_PT - (PDF_PAGE_MARGIN_PT * 2)
  const printableHeight = A4_HEIGHT_PT - (PDF_PAGE_MARGIN_PT * 2)
  const pageSliceHeight = Math.max(1, Math.floor(canvas.width * (printableHeight / printableWidth)))
  const renderScale = printableWidth / canvas.width
  const rowInkScores = buildCanvasRowInkScores(canvas)
  let offsetY = 0
  let pageIndex = 0

  while (offsetY < canvas.height) {
    const sliceHeight = computePageSliceHeight(rowInkScores, canvas.height, offsetY, pageSliceHeight)
    const pageCanvas = renderCanvasPage(canvas, offsetY, sliceHeight)
    const imageData = pageCanvas.toDataURL('image/png')
    const imageHeight = sliceHeight * renderScale

    if (pageIndex > 0) {
      pdf.addPage()
    }

    pdf.addImage(
      imageData,
      'PNG',
      PDF_PAGE_MARGIN_PT,
      PDF_PAGE_MARGIN_PT,
      printableWidth,
      imageHeight,
      undefined,
      'FAST',
    )
    offsetY += sliceHeight
    pageIndex += 1
  }

  return pdf.output('blob')
}

export async function exportTaskToPdfBlob(
  task: Pick<Task, 'public_id' | 'title' | 'description'>,
): Promise<Blob> {
  if (typeof document === 'undefined') {
    throw new Error('PDF export is only available in the browser.')
  }

  const documentModel = await buildTaskPdfExportDocument(task)
  return exportPdfDocumentModelToBlob(documentModel)
}

export async function exportDocumentToPdfBlob(
  documentItem: Pick<DocumentItem, 'title' | 'content_markdown'>,
): Promise<Blob> {
  if (typeof document === 'undefined') {
    throw new Error('PDF export is only available in the browser.')
  }

  const documentModel = await buildDocumentPdfExportDocument(documentItem)
  return exportPdfDocumentModelToBlob(documentModel)
}

async function exportPdfDocumentModelToBlob(documentModel: TaskPdfExportDocument): Promise<Blob> {
  const { host, captureTarget } = renderTaskPdfExportRoot(documentModel)
  window.document.body.appendChild(host)

  try {
    await waitForImages(captureTarget)
    const canvas = await html2canvas(captureTarget, {
      backgroundColor: '#ffffff',
      scale: 2,
      logging: false,
      useCORS: false,
      width: EXPORT_WIDTH_PX,
      windowWidth: EXPORT_WIDTH_PX,
    })
    return canvasToPdfBlob(canvas)
  } finally {
    host.remove()
  }
}
