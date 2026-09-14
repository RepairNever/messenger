import { AxiosError } from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getMock = vi.fn()
const postMock = vi.fn()
const patchMock = vi.fn()
const deleteMock = vi.fn()

vi.mock('@/services/http/client', () => ({
  createAuthenticatedClient: () => ({
    get: getMock,
    post: postMock,
    patch: patchMock,
    delete: deleteMock,
  }),
}))

const recordDto = {
  id: 'dayoff-1',
  user_id: 'user-1',
  type: 'vacation' as const,
  start_date: '2026-07-17',
  end_date: '2026-07-20',
  note: 'Summer break',
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-01T10:00:00Z',
}

describe('dayoffsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads the selected month and adapts snake_case records and employees', async () => {
    getMock.mockResolvedValueOnce({
      data: {
        employees: [{ id: 'user-1', display_name: 'Ada Lovelace', avatar_url: '/ada.png' }],
        records: [recordDto],
        year_totals: [{
          user_id: 'user-1',
          vacation_days: 12,
          sick_leave_days: 3,
          personal_days: 1,
        }],
      },
    })
    const { dayoffsList } = await import('@/services/http/dayoffsApi')

    const result = await dayoffsList(2026, 7)

    expect(getMock).toHaveBeenCalledWith('/api/dayoffs', { params: { year: 2026, month: 7 } })
    expect(result).toEqual({
      employees: [{ id: 'user-1', displayName: 'Ada Lovelace', avatarUrl: '/ada.png' }],
      records: [{
        id: 'dayoff-1',
        userId: 'user-1',
        type: 'vacation',
        startDate: '2026-07-17',
        endDate: '2026-07-20',
        note: 'Summer break',
        createdAt: '2026-07-01T10:00:00Z',
        updatedAt: '2026-07-01T10:00:00Z',
      }],
      yearTotals: [{
        userId: 'user-1',
        vacationDays: 12,
        sickLeaveDays: 3,
        personalDays: 1,
      }],
    })
  })

  it('accepts a legacy record array without losing records', async () => {
    getMock.mockResolvedValueOnce({ data: [recordDto] })
    const { dayoffsList } = await import('@/services/http/dayoffsApi')

    await expect(dayoffsList(2026, 7)).resolves.toMatchObject({
      employees: [],
      records: [{ id: 'dayoff-1', userId: 'user-1' }],
      yearTotals: [],
    })
  })

  it('sends camelCase create input as the API snake_case payload', async () => {
    postMock.mockResolvedValueOnce({ data: recordDto })
    const { dayoffsCreate } = await import('@/services/http/dayoffsApi')

    await dayoffsCreate({
      userId: 'user-1',
      type: 'vacation',
      startDate: '2026-07-17',
      endDate: '2026-07-20',
      note: null,
    })

    expect(postMock).toHaveBeenCalledWith('/api/dayoffs', {
      user_id: 'user-1',
      type: 'vacation',
      start_date: '2026-07-17',
      end_date: '2026-07-20',
      note: '',
    })
  })

  it('omits optional mutation fields when they are not supplied', async () => {
    patchMock.mockResolvedValueOnce({ data: recordDto })
    const { dayoffsUpdate } = await import('@/services/http/dayoffsApi')

    await dayoffsUpdate('dayoff-1', {
      type: 'sick_leave',
      startDate: '2026-07-17',
      endDate: '2026-07-20',
    })

    expect(patchMock).toHaveBeenCalledWith('/api/dayoffs/dayoff-1', {
      type: 'sick_leave',
      start_date: '2026-07-17',
      end_date: '2026-07-20',
    })
  })

  it('deletes a record using the Dayoffs endpoint', async () => {
    deleteMock.mockResolvedValueOnce({})
    const { dayoffsDelete } = await import('@/services/http/dayoffsApi')

    await dayoffsDelete('dayoff-1')

    expect(deleteMock).toHaveBeenCalledWith('/api/dayoffs/dayoff-1')
  })

  it('exposes overlap responses as a typed conflict error', async () => {
    postMock.mockRejectedValueOnce(new AxiosError(
      'Conflict',
      'ERR_BAD_REQUEST',
      undefined,
      undefined,
      {
        data: { error: 'dayoff overlaps an existing record' },
        status: 409,
        statusText: 'Conflict',
        headers: {},
        config: { headers: {} },
      } as any,
    ))
    const { DayoffsApiConflictError, dayoffsCreate } = await import('@/services/http/dayoffsApi')

    let thrown: unknown
    try {
      await dayoffsCreate({
        type: 'vacation',
        startDate: '2026-07-17',
        endDate: '2026-07-20',
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(DayoffsApiConflictError)
    expect(thrown).toEqual(expect.objectContaining({
      status: 409,
      message: 'dayoff overlaps an existing record',
    }))
  })

  it('rejects invalid month query values before a request is sent', async () => {
    const { dayoffsList } = await import('@/services/http/dayoffsApi')

    await expect(dayoffsList(2026, 13)).rejects.toThrow('Dayoffs month must be between 1 and 12')
    expect(getMock).not.toHaveBeenCalled()
  })
})
