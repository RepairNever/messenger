import type { CSSProperties } from 'vue'
import type { DayoffType } from '@/stores/dayoffs'

const VACATION_COLOR = '#298020'

export interface DayoffTypePresentation {
  label: string
  shortLabel: string
  style: CSSProperties
  barStyle: CSSProperties
}

// These colours deliberately draw from the active Msgnr theme rather than a
// separate palette. The labels are always rendered beside a colour cue, so the
// category is not conveyed by colour alone.
export const DAYOFF_TYPE_PRESENTATION: Record<DayoffType, DayoffTypePresentation> = {
  vacation: {
    label: 'Vacation',
    shortLabel: 'Vacation',
    style: {
      backgroundColor: 'rgb(41 128 32 / 0.14)',
      borderColor: 'rgb(41 128 32 / 0.45)',
      color: VACATION_COLOR,
    },
    barStyle: {
      backgroundColor: VACATION_COLOR,
    },
  },
  sick_leave: {
    label: 'Sick Leave',
    shortLabel: 'Sick',
    style: {
      backgroundColor: 'rgb(var(--color-status-amber) / 0.14)',
      borderColor: 'rgb(var(--color-status-amber) / 0.45)',
      color: 'rgb(var(--color-status-amber))',
    },
    barStyle: {
      backgroundColor: 'rgb(var(--color-status-amber) / 0.72)',
    },
  },
  personal_day: {
    label: 'Personal Day',
    shortLabel: 'Personal',
    style: {
      backgroundColor: 'rgb(var(--color-selection-border) / 0.14)',
      borderColor: 'rgb(var(--color-selection-border) / 0.45)',
      color: 'rgb(var(--color-selection-border))',
    },
    barStyle: {
      backgroundColor: 'rgb(var(--color-selection-border) / 0.72)',
    },
  },
}

export const DAYOFF_TYPE_OPTIONS = (Object.keys(DAYOFF_TYPE_PRESENTATION) as DayoffType[])
  .map(type => ({ type, ...DAYOFF_TYPE_PRESENTATION[type] }))

export function dayoffTypeLabel(type: DayoffType): string {
  return DAYOFF_TYPE_PRESENTATION[type].label
}

export function dayoffTypePresentation(type: DayoffType): DayoffTypePresentation {
  return DAYOFF_TYPE_PRESENTATION[type]
}
