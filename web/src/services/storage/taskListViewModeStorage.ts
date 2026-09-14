import { storage } from '@/services/storage/storageAdapter'

export type TaskListViewMode = 'list' | 'grouped'

const TASK_LIST_VIEW_MODE_KEY = 'msgnr:tasks:view-mode:v1'

export function loadTaskListViewMode(): TaskListViewMode {
  const raw = storage.getItem(TASK_LIST_VIEW_MODE_KEY)
  if (raw === 'grouped') return 'grouped'
  return 'list'
}

export function saveTaskListViewMode(mode: TaskListViewMode) {
  storage.setItem(TASK_LIST_VIEW_MODE_KEY, mode)
}

export function clearTaskListViewMode() {
  storage.removeItem(TASK_LIST_VIEW_MODE_KEY)
}
