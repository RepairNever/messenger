import { describe, expect, it, vi } from 'vitest'
import {
  boundaryColumnAtPointer,
  markTableBoundary,
  resizeColumnPair,
} from '@/editor/taskTableView'

function buildTable(): HTMLTableElement {
  const table = document.createElement('table')
  table.innerHTML = `
    <tbody>
      <tr><th>A</th><th>B</th><th>C</th></tr>
      <tr><td>1</td><td>2</td><td>3</td></tr>
      <tr><td>4</td><td>5</td><td>6</td></tr>
    </tbody>
  `
  return table
}

describe('taskTableView boundary helpers', () => {
  it('detects an internal boundary from any table row', () => {
    const table = buildTable()
    const cell = table.rows[1].cells[1]
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue({
      x: 50,
      y: 20,
      top: 20,
      right: 100,
      bottom: 40,
      left: 50,
      width: 50,
      height: 20,
      toJSON: () => ({}),
    })

    expect(boundaryColumnAtPointer(table, cell, 97)).toBe(1)
    expect(boundaryColumnAtPointer(table, cell, 80)).toBeNull()
  })

  it('does not expose the outer-right table edge as resizable', () => {
    const table = buildTable()
    const cell = table.rows[2].cells[2]
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 40,
      top: 40,
      right: 150,
      bottom: 60,
      left: 100,
      width: 50,
      height: 20,
      toJSON: () => ({}),
    })

    expect(boundaryColumnAtPointer(table, cell, 149)).toBeNull()
  })

  it('marks and clears a complete column boundary', () => {
    const table = buildTable()

    markTableBoundary(table, 1, 'hover')
    expect(table.querySelectorAll('.task-table-resize-edge-hover')).toHaveLength(3)

    markTableBoundary(table, 1, 'active')
    expect(table.querySelectorAll('.task-table-resize-edge-hover')).toHaveLength(0)
    expect(table.querySelectorAll('.task-table-resize-edge-active')).toHaveLength(3)

    markTableBoundary(table, null, null)
    expect(table.querySelectorAll('.task-table-resize-edge-active')).toHaveLength(0)
  })

  it('resizes only the adjacent pair while preserving the table width', () => {
    const start = [140, 120, 100]

    expect(resizeColumnPair(start, 0, 30)).toEqual([170, 90, 100])
    expect(resizeColumnPair(start, 0, 200)).toEqual([212, 48, 100])
    expect(resizeColumnPair(start, 0, -200)).toEqual([48, 212, 100])
    expect(resizeColumnPair(start, 2, 20)).toEqual(start)
  })
})
