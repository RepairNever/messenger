import { describe, expect, it } from 'vitest'
import { findStandaloneCurrentWorkspaceTaskUrl } from '@/utils/taskUrlMention'

const workspaceOrigin = 'https://chat.example.test:8443'

describe('findStandaloneCurrentWorkspaceTaskUrl', () => {
  it('recognizes a canonical copied task URL and preserves its text range', () => {
    const url = `${workspaceOrigin}/tasks/dev-123`
    const pastedText = `\n  ${url} \t`

    expect(findStandaloneCurrentWorkspaceTaskUrl(pastedText, workspaceOrigin)).toEqual({
      publicId: 'DEV-123',
      url,
      start: '\n  '.length,
      end: '\n  '.length + url.length,
    })
  })

  it('requires the exact canonical route emitted by the copy action', () => {
    const cases = [
      `${workspaceOrigin}/tasks/DEV-123`,
      `${workspaceOrigin}/tasks/dev-123/`,
      `${workspaceOrigin}/tasks/dev-123?source=clipboard`,
      `${workspaceOrigin}/tasks/dev-123#details`,
      `${workspaceOrigin}/tasks/kanban`,
      `${workspaceOrigin}/tasks/92f41023-40a9-42f7-a124-38d426e061ba`,
      `${workspaceOrigin}/tasks/dev%2D123`,
    ]

    for (const value of cases) {
      expect(findStandaloneCurrentWorkspaceTaskUrl(value, workspaceOrigin)).toBeNull()
    }
  })

  it('rejects URLs from another workspace or a different protocol or port', () => {
    const cases = [
      'https://other.example.test:8443/tasks/dev-123',
      'http://chat.example.test:8443/tasks/dev-123',
      'https://chat.example.test/tasks/dev-123',
      'https://user@chat.example.test:8443/tasks/dev-123',
    ]

    for (const value of cases) {
      expect(findStandaloneCurrentWorkspaceTaskUrl(value, workspaceOrigin)).toBeNull()
    }
  })

  it('only accepts a standalone URL apart from surrounding whitespace', () => {
    const url = `${workspaceOrigin}/tasks/dev-123`
    const cases = [
      `See ${url}`,
      `${url}\n${url}`,
      `/tasks/dev-123`,
      '',
      ' \n\t ',
    ]

    for (const value of cases) {
      expect(findStandaloneCurrentWorkspaceTaskUrl(value, workspaceOrigin)).toBeNull()
    }
  })
})
