import { Extension } from '@tiptap/core'
import { TableView } from '@tiptap/extension-table'
import type { Attrs, Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, type Transaction } from '@tiptap/pm/state'
import {
  TableMap,
  addColumn,
  addRow,
  removeColumn,
  type TableRect,
} from '@tiptap/pm/tables'
import type { EditorView, ViewMutationRecord } from '@tiptap/pm/view'

export const TASK_TABLE_CELL_MIN_WIDTH = 48
export const RESIZE_HIT_WIDTH_PX = 12

type ResizeInput = 'mouse' | 'pointer'

type ResizeSession = {
  boundary: number
  currentWidths: number[]
  input: ResizeInput
  pointerId: number | null
  startWidths: number[]
  startX: number
}

type TableColumnWidthChange = {
  attrs: Attrs
  colwidth: number[]
}

export function boundaryColumnAtPointer(
  table: HTMLTableElement,
  target: EventTarget | null,
  clientX: number,
): number | null {
  const element = target instanceof Element ? target : null
  const cell = element?.closest('th, td') as HTMLTableCellElement | null
  if (!cell || !table.contains(cell)) return null

  const row = cell.parentElement as HTMLTableRowElement | null
  const firstRow = table.rows.item(0)
  if (!row || !firstRow) return null

  const column = Array.from(row.cells).indexOf(cell)
  if (column < 0 || column >= firstRow.cells.length - 1) return null

  const rect = cell.getBoundingClientRect()
  if (clientX < rect.right - RESIZE_HIT_WIDTH_PX || clientX > rect.right + RESIZE_HIT_WIDTH_PX) {
    return null
  }
  return column
}

export function resizeColumnPair(
  widths: readonly number[],
  boundary: number,
  pointerDelta: number,
  minimumWidth = TASK_TABLE_CELL_MIN_WIDTH,
): number[] {
  if (boundary < 0 || boundary >= widths.length - 1) return [...widths]

  const leftStart = widths[boundary] ?? minimumWidth
  const rightStart = widths[boundary + 1] ?? minimumWidth
  const delta = Math.min(
    rightStart - minimumWidth,
    Math.max(minimumWidth - leftStart, pointerDelta),
  )
  const nextWidths = [...widths]
  nextWidths[boundary] = Math.round(leftStart + delta)
  nextWidths[boundary + 1] = Math.round(rightStart - delta)
  return nextWidths
}

export function applyTableColumnWidths(
  transaction: Transaction,
  table: ProseMirrorNode,
  tableStart: number,
  widths: readonly number[],
): void {
  const map = TableMap.get(table)
  if (widths.length !== map.width) return

  const changes = new Map<number, TableColumnWidthChange>()
  for (let column = 0; column < widths.length; column += 1) {
    for (let row = 0; row < map.height; row += 1) {
      const mapIndex = row * map.width + column
      const relativePos = map.map[mapIndex]
      if (row > 0 && relativePos === map.map[mapIndex - map.width]) continue

      const cell = table.nodeAt(relativePos)
      if (!cell) continue

      const attrs = cell.attrs
      const colspan = Math.max(1, Number(attrs.colspan) || 1)
      const widthIndex = column - map.colCount(relativePos)
      if (widthIndex < 0 || widthIndex >= colspan) continue

      const existing = changes.get(relativePos)
      const existingWidths = Array.isArray(attrs.colwidth) ? attrs.colwidth : []
      const colwidth = existing?.colwidth ?? Array.from(
        { length: colspan },
        (_, index) => {
          const width = existingWidths[index]
          return typeof width === 'number' ? width : 0
        },
      )
      colwidth[widthIndex] = Math.round(widths[column] ?? TASK_TABLE_CELL_MIN_WIDTH)
      changes.set(relativePos, { attrs, colwidth })
    }
  }

  for (const [relativePos, change] of changes) {
    transaction.setNodeMarkup(tableStart + relativePos, null, {
      ...change.attrs,
      colwidth: change.colwidth,
    })
  }
}

export function persistTableColumnWidths(
  view: EditorView,
  tablePosition: number,
  widths: readonly number[],
): boolean {
  const table = view.state.doc.nodeAt(tablePosition)
  if (!table) return false
  const tableStart = tablePosition + 1
  const transaction = view.state.tr
  applyTableColumnWidths(transaction, table, tableStart, widths)
  if (!transaction.docChanged) return false
  view.dispatch(transaction)
  return true
}

export function markTableBoundary(
  table: HTMLTableElement,
  column: number | null,
  state: 'hover' | 'active' | null,
): void {
  for (const cell of table.querySelectorAll('.task-table-resize-edge-hover, .task-table-resize-edge-active')) {
    cell.classList.remove('task-table-resize-edge-hover', 'task-table-resize-edge-active')
  }
  if (column === null || state === null) return

  const className = state === 'active'
    ? 'task-table-resize-edge-active'
    : 'task-table-resize-edge-hover'
  for (const row of Array.from(table.rows)) {
    row.cells.item(column)?.classList.add(className)
  }
}

export class TaskTableView extends TableView {
  private readonly addColumnButton: HTMLButtonElement
  private readonly addRowButton: HTMLButtonElement
  private readonly columnActionsButton: HTMLButtonElement
  private readonly columnDeleteMenu: HTMLDivElement
  private readonly deleteColumnButton: HTMLButtonElement
  private readonly getTablePos: () => number | undefined
  private readonly minimumCellWidth: number
  private readonly scrollViewport: HTMLDivElement
  private readonly view: EditorView
  private activeColumn: number | null = null
  private columnMenuColumn: number | null = null
  private columnMenuHeader: HTMLTableCellElement | null = null
  private columnMenuOpen = false
  private hoveredColumn: number | null = null
  private resizeSession: ResizeSession | null = null

  constructor(
    node: ProseMirrorNode,
    cellMinWidth: number,
    view: EditorView,
    getTablePos: () => number | undefined,
  ) {
    super(node, cellMinWidth)
    this.view = view
    this.getTablePos = getTablePos
    this.minimumCellWidth = cellMinWidth
    this.dom.classList.add('task-table-wrapper')

    this.scrollViewport = document.createElement('div')
    this.scrollViewport.className = 'task-table-scroll'
    this.scrollViewport.setAttribute('data-testid', 'task-description-table-scroll')
    this.dom.insertBefore(this.scrollViewport, this.table)
    this.scrollViewport.append(this.table)

    this.addColumnButton = this.createControl(
      'column',
      'Add table column',
      'task-description-table-edge-add-column',
    )
    this.addRowButton = this.createControl(
      'row',
      'Add table row',
      'task-description-table-edge-add-row',
    )
    this.columnActionsButton = this.createColumnActionsButton()
    this.columnDeleteMenu = document.createElement('div')
    this.columnDeleteMenu.className = 'task-table-column-menu'
    this.columnDeleteMenu.dataset.testid = 'task-description-table-delete-column-menu'
    this.columnDeleteMenu.setAttribute('contenteditable', 'false')
    this.columnDeleteMenu.setAttribute('role', 'menu')
    this.columnDeleteMenu.hidden = true
    this.deleteColumnButton = this.createDeleteColumnButton()
    this.columnDeleteMenu.append(this.deleteColumnButton)
    this.dom.append(
      this.addColumnButton,
      this.addRowButton,
      this.columnActionsButton,
      this.columnDeleteMenu,
    )
    this.syncEditableState()

    this.addColumnButton.addEventListener('click', this.handleAddColumn)
    this.addRowButton.addEventListener('click', this.handleAddRow)
    this.columnActionsButton.addEventListener('click', this.handleColumnActionsToggle)
    this.deleteColumnButton.addEventListener('click', this.handleDeleteColumn)
    this.dom.addEventListener('mousemove', this.handleMouseMove, true)
    this.dom.addEventListener('mouseleave', this.handleMouseLeave)
    this.dom.addEventListener('mousedown', this.handleMouseDown, true)
    this.dom.addEventListener('pointerdown', this.handlePointerDown, true)
    this.dom.addEventListener('pointermove', this.handlePointerMove, true)
    this.scrollViewport.addEventListener('scroll', this.handleScroll)
    this.dom.ownerDocument.addEventListener('mousedown', this.handleDocumentMouseDown, true)
    this.dom.ownerDocument.addEventListener('keydown', this.handleDocumentKeydown)
  }

  update(node: ProseMirrorNode): boolean {
    const updated = super.update(node)
    if (!updated) return false

    this.syncEditableState()
    queueMicrotask(() => this.repositionColumnActions())
    return true
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (
      mutation.type === 'attributes'
      && mutation.target instanceof Node
      && this.dom.contains(mutation.target)
      && !this.table.contains(mutation.target)
    ) {
      return true
    }
    return super.ignoreMutation(mutation)
  }

  private createControl(kind: 'column' | 'row', label: string, testId: string): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `task-table-add task-table-add--${kind}`
    button.dataset.testid = testId
    button.setAttribute('contenteditable', 'false')
    button.setAttribute('aria-label', label)
    button.title = label
    button.textContent = '+'
    return button
  }

  private createColumnActionsButton(): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'task-table-column-actions'
    button.dataset.testid = 'task-description-table-column-actions'
    button.setAttribute('contenteditable', 'false')
    button.setAttribute('aria-label', 'Column actions')
    button.setAttribute('aria-haspopup', 'menu')
    button.setAttribute('aria-expanded', 'false')
    button.title = 'Column actions'
    button.textContent = '⋯'
    button.hidden = true
    return button
  }

  private createDeleteColumnButton(): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'task-table-column-menu-item task-table-column-menu-item--danger'
    button.dataset.testid = 'task-description-table-delete-column-action'
    button.setAttribute('contenteditable', 'false')
    button.setAttribute('role', 'menuitem')
    button.textContent = 'Delete column'
    return button
  }

  private isTableControl(target: EventTarget | null): boolean {
    const element = target instanceof Element ? target : null
    return Boolean(element?.closest('.task-table-add, .task-table-column-actions, .task-table-column-menu'))
  }

  private getHeaderCell(column: number | null): HTMLTableCellElement | null {
    if (column === null) return null
    return this.table.rows.item(0)?.cells.item(column) ?? null
  }

  private getColumnCount(): number {
    return TableMap.get(this.node).width
  }

  private getRowCount(): number {
    return TableMap.get(this.node).height
  }

  private syncEditableState(): void {
    const editable = this.view.editable
    const hasCells = this.getColumnCount() > 0
    const canDeleteColumn = editable && this.getColumnCount() > 1
    this.dom.classList.toggle('task-table-wrapper--editable', editable && hasCells)
    for (const button of [this.addColumnButton, this.addRowButton]) {
      button.disabled = !editable || !hasCells
      button.tabIndex = editable && hasCells ? 0 : -1
    }
    this.columnActionsButton.disabled = !canDeleteColumn
    this.columnActionsButton.tabIndex = canDeleteColumn ? 0 : -1
    this.deleteColumnButton.disabled = !canDeleteColumn
    if (!editable || !hasCells) this.closeColumnMenu(true)
  }

  private tableRectAt(row: number, column: number): TableRect | null {
    const tablePosition = this.getTablePos()
    if (typeof tablePosition !== 'number') return null

    const table = this.view.state.doc.nodeAt(tablePosition)
    if (!table) return null
    const map = TableMap.get(table)
    if (row < 0 || row >= map.height || column < 0 || column >= map.width) return null
    const cellPosition = map.map[row * map.width + column]
    if (typeof cellPosition !== 'number') return null
    return {
      ...map.findCell(cellPosition),
      map,
      table,
      tableStart: tablePosition + 1,
    }
  }

  private handleAddColumn = (event: MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    this.syncEditableState()
    const rect = this.tableRectAt(0, this.getColumnCount() - 1)
    if (!rect) return
    this.view.dispatch(addColumn(this.view.state.tr, rect, rect.right))
    this.view.focus()
  }

  private handleAddRow = (event: MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    this.syncEditableState()
    const rect = this.tableRectAt(this.getRowCount() - 1, 0)
    if (!rect) return
    this.view.dispatch(addRow(this.view.state.tr, rect, rect.bottom))
    this.view.focus()
  }

  private handleColumnActionsToggle = (event: MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    this.syncEditableState()
    if (this.columnActionsButton.disabled || this.columnMenuColumn === null) return
    this.columnMenuOpen = !this.columnMenuOpen
    this.columnDeleteMenu.hidden = !this.columnMenuOpen
    this.columnActionsButton.setAttribute('aria-expanded', String(this.columnMenuOpen))
    this.repositionColumnActions()
  }

  private handleDeleteColumn = (event: MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    this.syncEditableState()
    const column = this.columnMenuColumn
    if (this.deleteColumnButton.disabled || column === null) return

    const rect = this.tableRectAt(0, column)
    if (!rect || rect.map.width <= 1) return
    const transaction = this.view.state.tr
    removeColumn(transaction, rect, rect.left)
    this.view.dispatch(transaction)
    this.closeColumnMenu(true)
    this.view.focus()
  }

  private updatePointerState(event: MouseEvent | PointerEvent): void {
    const target = event.target instanceof Element ? event.target : null
    if (!target || !this.table.contains(target)) return

    event.stopPropagation()
    const header = target.closest('th') as HTMLTableCellElement | null
    if (header && this.table.contains(header)) {
      this.showColumnActions(header)
    } else if (!this.columnMenuOpen) {
      this.hideColumnActions()
    }

    this.hoveredColumn = boundaryColumnAtPointer(this.table, target, event.clientX)
    markTableBoundary(this.table, this.hoveredColumn, this.hoveredColumn === null ? null : 'hover')
  }

  private handleMouseMove = (event: MouseEvent): void => {
    if (this.resizeSession) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    this.updatePointerState(event)
  }

  private handlePointerMove = (event: PointerEvent): void => {
    if (this.resizeSession) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    this.updatePointerState(event)
  }

  private handleMouseLeave = (): void => {
    if (this.resizeSession) return
    this.hoveredColumn = null
    markTableBoundary(this.table, null, null)
    if (!this.columnMenuOpen) this.hideColumnActions()
  }

  private handleMouseDown = (event: MouseEvent): void => {
    if (this.isTableControl(event.target)) {
      event.stopPropagation()
      return
    }
    if (this.resizeSession) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (!this.beginResize(event, 'mouse', null)) return
    event.preventDefault()
    event.stopPropagation()
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (this.isTableControl(event.target)) {
      event.stopPropagation()
      return
    }
    if (this.resizeSession) return
    if (!this.beginResize(event, 'pointer', event.pointerId)) return
    try {
      this.dom.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture is not available in every embedded browser context.
    }
    event.preventDefault()
    event.stopPropagation()
  }

  private beginResize(
    event: MouseEvent | PointerEvent,
    input: ResizeInput,
    pointerId: number | null,
  ): boolean {
    if (!this.view.editable || event.button !== 0) return false
    const boundary = boundaryColumnAtPointer(this.table, event.target, event.clientX)
    if (boundary === null) return false

    const startWidths = this.readColumnWidths()
    if (boundary >= startWidths.length - 1) return false
    this.resizeSession = {
      boundary,
      currentWidths: startWidths,
      input,
      pointerId,
      startWidths,
      startX: event.clientX,
    }
    this.activeColumn = boundary
    this.hoveredColumn = boundary
    this.applyColumnWidths(startWidths)
    markTableBoundary(this.table, boundary, 'active')
    document.body.classList.add('task-table-is-resizing')
    this.hideColumnActions()

    const ownerDocument = this.dom.ownerDocument
    if (input === 'pointer') {
      ownerDocument.addEventListener('pointermove', this.handleDocumentPointerMove, true)
      ownerDocument.addEventListener('pointerup', this.handleDocumentPointerUp, true)
      ownerDocument.addEventListener('pointercancel', this.handleDocumentPointerCancel, true)
    } else {
      ownerDocument.addEventListener('mousemove', this.handleDocumentMouseMove, true)
      ownerDocument.addEventListener('mouseup', this.handleDocumentMouseUp, true)
    }
    return true
  }

  private handleDocumentMouseMove = (event: MouseEvent): void => {
    if (this.resizeSession?.input !== 'mouse') return
    this.resizeTo(event.clientX)
    event.preventDefault()
    event.stopPropagation()
  }

  private handleDocumentMouseUp = (event: MouseEvent): void => {
    if (this.resizeSession?.input !== 'mouse') return
    this.resizeTo(event.clientX)
    this.finishResize()
    event.preventDefault()
    event.stopPropagation()
  }

  private handleDocumentPointerMove = (event: PointerEvent): void => {
    if (this.resizeSession?.input !== 'pointer' || event.pointerId !== this.resizeSession.pointerId) return
    this.resizeTo(event.clientX)
    event.preventDefault()
    event.stopPropagation()
  }

  private handleDocumentPointerUp = (event: PointerEvent): void => {
    if (this.resizeSession?.input !== 'pointer' || event.pointerId !== this.resizeSession.pointerId) return
    this.resizeTo(event.clientX)
    this.finishResize()
    event.preventDefault()
    event.stopPropagation()
  }

  private handleDocumentPointerCancel = (event: PointerEvent): void => {
    if (this.resizeSession?.input !== 'pointer' || event.pointerId !== this.resizeSession.pointerId) return
    this.finishResize()
    event.preventDefault()
    event.stopPropagation()
  }

  private resizeTo(clientX: number): void {
    const session = this.resizeSession
    if (!session) return
    const widths = resizeColumnPair(
      session.startWidths,
      session.boundary,
      clientX - session.startX,
      this.minimumCellWidth,
    )
    session.currentWidths = widths
    this.applyColumnWidths(widths)
  }

  private readColumnWidths(): number[] {
    const firstRow = this.table.rows.item(0)
    const columns = Array.from(this.colgroup.children) as HTMLTableColElement[]
    return columns.map((column, index) => {
      const columnWidth = column.getBoundingClientRect().width
      const configuredWidth = Number.parseFloat(column.style.width)
      const cellWidth = firstRow?.cells.item(index)?.getBoundingClientRect().width ?? 0
      const width = columnWidth || configuredWidth || cellWidth || this.minimumCellWidth
      return Math.max(this.minimumCellWidth, Math.round(width))
    })
  }

  private applyColumnWidths(widths: readonly number[]): void {
    const columns = Array.from(this.colgroup.children) as HTMLTableColElement[]
    widths.forEach((width, index) => {
      const column = columns[index]
      if (column) column.style.width = `${Math.round(width)}px`
    })
    const totalWidth = widths.reduce((total, width) => total + width, 0)
    this.table.style.width = `${Math.round(totalWidth)}px`
    this.table.style.minWidth = ''
  }

  private finishResize(): void {
    const session = this.resizeSession
    if (!session) return
    this.resizeSession = null
    const ownerDocument = this.dom.ownerDocument
    ownerDocument.removeEventListener('mousemove', this.handleDocumentMouseMove, true)
    ownerDocument.removeEventListener('mouseup', this.handleDocumentMouseUp, true)
    ownerDocument.removeEventListener('pointermove', this.handleDocumentPointerMove, true)
    ownerDocument.removeEventListener('pointerup', this.handleDocumentPointerUp, true)
    ownerDocument.removeEventListener('pointercancel', this.handleDocumentPointerCancel, true)
    if (session.pointerId !== null) {
      try {
        if (this.dom.hasPointerCapture(session.pointerId)) this.dom.releasePointerCapture(session.pointerId)
      } catch {
        // A released pointer must not prevent the editor from remaining usable.
      }
    }

    const tablePosition = this.getTablePos()
    if (typeof tablePosition === 'number') {
      persistTableColumnWidths(this.view, tablePosition, session.currentWidths)
    }
    this.activeColumn = null
    this.hoveredColumn = null
    markTableBoundary(this.table, null, null)
    document.body.classList.remove('task-table-is-resizing')
  }

  private showColumnActions(header: HTMLTableCellElement): void {
    if (!this.view.editable || this.getColumnCount() <= 1) return
    const firstRow = this.table.rows.item(0)
    const column = firstRow ? Array.from(firstRow.cells).indexOf(header) : -1
    if (column < 0) return

    this.columnMenuColumn = column
    this.columnMenuHeader = header
    this.columnActionsButton.hidden = false
    this.repositionColumnActions()
  }

  private hideColumnActions(): void {
    if (this.columnMenuOpen) return
    this.columnActionsButton.hidden = true
    this.columnMenuColumn = null
    this.columnMenuHeader = null
  }

  private closeColumnMenu(hideActions: boolean): void {
    this.columnMenuOpen = false
    this.columnDeleteMenu.hidden = true
    this.columnActionsButton.setAttribute('aria-expanded', 'false')
    if (hideActions) {
      this.columnActionsButton.hidden = true
      this.columnMenuColumn = null
      this.columnMenuHeader = null
    }
  }

  private repositionColumnActions = (): void => {
    const header = this.getHeaderCell(this.columnMenuColumn) ?? this.columnMenuHeader
    if (!header || !this.dom.contains(header)) {
      this.closeColumnMenu(true)
      return
    }

    const wrapperRect = this.dom.getBoundingClientRect()
    const headerRect = header.getBoundingClientRect()
    const actionSize = 20
    const actionLeft = Math.max(0, headerRect.right - wrapperRect.left - actionSize - 3)
    const actionTop = Math.max(0, headerRect.top - wrapperRect.top + 3)
    this.columnActionsButton.style.left = `${Math.round(actionLeft)}px`
    this.columnActionsButton.style.top = `${Math.round(actionTop)}px`

    if (this.columnMenuOpen) {
      const menuLeft = Math.max(0, Math.min(
        headerRect.left - wrapperRect.left,
        wrapperRect.width - 168,
      ))
      const menuTop = Math.max(0, headerRect.bottom - wrapperRect.top + 4)
      this.columnDeleteMenu.style.left = `${Math.round(menuLeft)}px`
      this.columnDeleteMenu.style.top = `${Math.round(menuTop)}px`
    }
  }

  private handleScroll = (): void => {
    this.repositionColumnActions()
  }

  private handleDocumentMouseDown = (event: MouseEvent): void => {
    if (!this.columnMenuOpen) return
    const target = event.target instanceof Node ? event.target : null
    if (target && (this.columnDeleteMenu.contains(target) || this.columnActionsButton.contains(target))) return
    this.closeColumnMenu(true)
  }

  private handleDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.columnMenuOpen) return
    event.preventDefault()
    this.closeColumnMenu(false)
    this.columnActionsButton.focus()
  }

  destroy(): void {
    this.finishResize()
    this.addColumnButton.removeEventListener('click', this.handleAddColumn)
    this.addRowButton.removeEventListener('click', this.handleAddRow)
    this.columnActionsButton.removeEventListener('click', this.handleColumnActionsToggle)
    this.deleteColumnButton.removeEventListener('click', this.handleDeleteColumn)
    this.dom.removeEventListener('mousemove', this.handleMouseMove, true)
    this.dom.removeEventListener('mouseleave', this.handleMouseLeave)
    this.dom.removeEventListener('mousedown', this.handleMouseDown, true)
    this.dom.removeEventListener('pointerdown', this.handlePointerDown, true)
    this.dom.removeEventListener('pointermove', this.handlePointerMove, true)
    this.scrollViewport.removeEventListener('scroll', this.handleScroll)
    this.dom.ownerDocument.removeEventListener('mousedown', this.handleDocumentMouseDown, true)
    this.dom.ownerDocument.removeEventListener('keydown', this.handleDocumentKeydown)
    document.body.classList.remove('task-table-is-resizing')
    markTableBoundary(this.table, null, null)
  }
}

export const TaskTableNodeViewExtension = Extension.create({
  name: 'taskTableNodeView',
  // This must register before the table extension so the custom node view owns resizing.
  priority: 1_000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          nodeViews: {
            table: (node, view, getPos) => new TaskTableView(node, TASK_TABLE_CELL_MIN_WIDTH, view, getPos),
          },
        },
      }),
    ]
  },
})
