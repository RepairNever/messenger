import { defineStore } from 'pinia'
import { ref, computed, readonly } from 'vue'
import {
  tasksListTemplates,
  tasksListStatuses,
  tasksListFields,
  tasksListUsers,
  tasksGetConfigDictionary,
  tasksListFilterableDictionaries,
  tasksGetDictionaryVersionItems,
  tasksListDictionaryVersions,
  tasksCreatePublicDictionaryItem,
  tasksCreate,
  tasksGet,
  tasksUpdate,
  tasksUpdateTaskTitle,
  tasksUpdateTaskStatus,
  tasksUpdateTaskDescription,
  tasksListTaskDescriptionHistory,
  tasksListTaskChangeHistory,
  tasksUpdateTaskFieldValue,
  tasksCreateSubtask,
  tasksListTasks,
  tasksListGrouped,
  tasksListStatusPortion,
  type TaskTemplate,
  type TaskStatus,
  type TaskFieldDefinition,
  type TaskUser,
  type EnumDictionary,
  type EnumDictionaryVersionItem,
  type Task,
  type TaskFieldValue,
  type TaskListItem,
  type TaskListGroup,
  type TaskListParams,
  type TaskGroupedItem,
  type TaskGroupedStatusBucket,
  type TaskDescriptionHistoryItem,
  type TaskChangeHistoryPage,
  type SortOrder,
  type CreateTaskPayload,
  type UpdateTaskPayload,
  type UpdateTaskTitlePayload,
} from '@/services/http/tasksApi'
import { useChatStore } from '@/stores/chat'
import { userCustomStatusFromDto } from '@/types/userStatus'

const DEBUG_TASKS_DESC = import.meta.env.DEV

function descriptionSignature(value: string | null | undefined): string {
  if (value == null) return 'null'
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i)
    hash |= 0
  }
  const preview = value.slice(0, 80).replace(/\n/g, '\\n')
  return `len=${value.length},hash=${hash},preview="${preview}"`
}

function tasksDescLog(event: string, payload: Record<string, unknown>) {
  if (!DEBUG_TASKS_DESC) return
  console.debug('[tasks-store-desc]', event, payload)
}

type TaskListLoadMode = 'list' | 'grouped'

const DEFAULT_LIST_PARAMS: TaskListParams = {
  page: 1,
  page_size: 50,
  sort_by: 'updated_at',
  sort_order: 'desc',
}

type GroupedTaskGroupState = TaskGroupedStatusBucket & {
  next_offset: number
  has_more: boolean
  loading_more: boolean
  load_more_error: string | null
}

export const useTasksStore = defineStore('tasks', () => {
  // ---- Config (templates, statuses, fields) ----
  const templates = ref<TaskTemplate[]>([])
  const statuses = ref<TaskStatus[]>([])
  const fieldsByTemplate = ref<Record<string, TaskFieldDefinition[]>>({})
  const configLoaded = ref(false)
  const configLoading = ref(false)
  const configError = ref<string | null>(null)
  let configLoadPromise: Promise<void> | null = null

  // ---- Shared lookup data ----
  // Loaded once; injected into field inputs via props so there are no per-instance fetches.
  const users = ref<TaskUser[]>([])
  const usersLoaded = ref(false)
  const enumDictionariesById = ref<Record<string, EnumDictionary>>({})
  const filterableEnumDictionaries = ref<EnumDictionary[]>([])
  // Latest search result keyed by dictionary_id.
  const enumItemsByDict = ref<Record<string, EnumDictionaryVersionItem[]>>({})
  // Known item labels keyed by dictionary_id; merged from search results and selected-value hydration.
  const enumKnownItemsByDict = ref<Record<string, EnumDictionaryVersionItem[]>>({})
  // version number loaded for each dictionary_id
  const enumVersionByDict = ref<Record<string, number>>({})
  const enumLatestVersionIdByDict = ref<Record<string, string>>({})
  const enumItemCreateLoadingByDict = ref<Record<string, boolean>>({})
  const enumItemSearchLoadingByDict = ref<Record<string, boolean>>({})
  const enumItemSearchTokenByDict = ref<Record<string, number>>({})
  const enumDictionaryLoadPromises = new Map<string, Promise<void>>()

  // ---- Selected task ----
  const selectedTask = ref<Task | null>(null)
  const taskLoading = ref(false)
  const taskError = ref<string | null>(null)

  // ---- Create dialog ----
  const createDialogOpen = ref(false)

  // ---- Task list ----
  // List mode prefers the backend's globally sorted flat page and falls back
  // to flattening groups for compatibility with older responses.
  const taskListItems = ref<TaskListItem[]>([])
  const taskListGroups = ref<TaskListGroup[]>([])
  const taskListTotal = ref(0)
  const taskListLoading = ref(false)
  const taskListError = ref<string | null>(null)
  const listParams = ref<TaskListParams>({ ...DEFAULT_LIST_PARAMS })

  // Grouped mode (GET /api/tasks/grouped + /api/tasks/status/:id/portion)
  const groupedTaskStatusOrder = ref<string[]>([])
  const groupedTaskGroupsByStatus = ref<Record<string, GroupedTaskGroupState>>({})
  const groupedTaskPortionLimit = ref(50)

  const taskList = computed<TaskListItem[]>(() => taskListItems.value)

  // ---- Derived ----
  const activeTemplates = computed(() =>
    templates.value.filter(t => !t.deleted_at).sort((a, b) => a.sort_order - b.sort_order),
  )

  const activeStatuses = computed(() =>
    statuses.value.filter(s => !s.deleted_at).sort((a, b) => a.sort_order - b.sort_order),
  )

  function allStatuses(): TaskStatus[] {
    return statuses.value.slice().sort((a, b) => a.sort_order - b.sort_order)
  }

  function activeFieldsFor(templateId: string): TaskFieldDefinition[] {
    return (fieldsByTemplate.value[templateId] ?? [])
      .filter(f => !f.deleted_at)
      .sort((a, b) => a.sort_order - b.sort_order)
  }

  // All active assignee field definition IDs across every loaded template.
  // Used by the task list assignee filter to build field_<uuid>_user params.
  const assigneeFieldIds = computed<string[]>(() =>
    Object.values(fieldsByTemplate.value)
      .flat()
      .filter(f => f.field_role === 'assignee' && !f.deleted_at)
      .map(f => f.id),
  )

  function statusById(id: string): TaskStatus | undefined {
    return statuses.value.find(s => s.id === id)
  }

  function templateById(id: string): TaskTemplate | undefined {
    return templates.value.find(t => t.id === id)
  }

  function enumItemsFor(dictionaryId: string): EnumDictionaryVersionItem[] {
    return enumItemsByDict.value[dictionaryId] ?? []
  }

  function enumKnownItemsFor(dictionaryId: string): EnumDictionaryVersionItem[] {
    return enumKnownItemsByDict.value[dictionaryId] ?? []
  }

  function enumDictionaryFor(dictionaryId: string): EnumDictionary | undefined {
    return enumDictionariesById.value[dictionaryId]
  }

  function listFilterParams(): TaskListParams {
    return {
      search: listParams.value.search,
      status_ids: listParams.value.status_ids,
      prefixes: listParams.value.prefixes,
      include_subtasks: listParams.value.include_subtasks,
      field_filters: listParams.value.field_filters,
      dictionary_filters: listParams.value.dictionary_filters,
    }
  }

  function replaceGroupedStatusState(statusId: string, next: GroupedTaskGroupState) {
    groupedTaskGroupsByStatus.value = {
      ...groupedTaskGroupsByStatus.value,
      [statusId]: next,
    }
  }

  // ---- Actions ----

  async function loadConfig() {
    if (configLoaded.value) return
    if (configLoadPromise) return configLoadPromise

    configLoading.value = true
    configError.value = null
    configLoadPromise = (async () => {
      try {
        const [tpls, sts] = await Promise.all([
          tasksListTemplates(false),
          tasksListStatuses(false),
        ])
        templates.value = tpls
        statuses.value = sts
        configLoaded.value = true
      } catch (e) {
        configError.value = e instanceof Error ? e.message : 'Failed to load configuration'
      } finally {
        configLoading.value = false
        configLoadPromise = null
      }
    })()

    return configLoadPromise
  }

  async function loadFieldsFor(templateId: string) {
    if (fieldsByTemplate.value[templateId]) return
    try {
      const fields = await tasksListFields(templateId, false)
      fieldsByTemplate.value = { ...fieldsByTemplate.value, [templateId]: fields }
    } catch {
      // non-fatal — fields just won't render
    }
  }

  // Loads fields for every active template in parallel.
  // Needed by the task list to discover all assignee field IDs upfront.
  async function loadAllTemplateFields() {
    await Promise.all(activeTemplates.value.map(t => loadFieldsFor(t.id)))
  }

  async function loadUsers() {
    if (usersLoaded.value) return
    try {
      users.value = await tasksListUsers()
      const chatStore = useChatStore()
      for (const user of users.value) {
        chatStore.registerUserIdentity(
          user.id,
          user.display_name,
          user.email,
          user.avatar_url ?? '',
          userCustomStatusFromDto(user.custom_status),
        )
      }
      usersLoaded.value = true
    } catch {
      // non-fatal — user selectors will be empty
    }
  }

  async function loadFilterableDictionaries() {
    try {
      const dictionaries = await tasksListFilterableDictionaries()
      filterableEnumDictionaries.value = dictionaries
      enumDictionariesById.value = {
        ...enumDictionariesById.value,
        ...Object.fromEntries(dictionaries.map(dictionary => [dictionary.id, dictionary])),
      }
    } catch {
      filterableEnumDictionaries.value = []
    }
  }

  function mergeKnownEnumItems(dictionaryId: string, items: EnumDictionaryVersionItem[]) {
    const merged = new Map<string, EnumDictionaryVersionItem>()
    for (const item of enumKnownItemsByDict.value[dictionaryId] ?? []) {
      merged.set(item.value_code, item)
    }
    for (const item of items) {
      merged.set(item.value_code, item)
    }
    enumKnownItemsByDict.value = {
      ...enumKnownItemsByDict.value,
      [dictionaryId]: Array.from(merged.values()).sort((a, b) => {
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
        return a.value_name.localeCompare(b.value_name)
      }),
    }
  }

  async function ensureEnumDictionaryLoaded(dictionaryId: string) {
    if (enumDictionariesById.value[dictionaryId] && enumLatestVersionIdByDict.value[dictionaryId]) return
    const inFlight = enumDictionaryLoadPromises.get(dictionaryId)
    if (inFlight) {
      await inFlight
      return
    }

    const loadPromise = (async () => {
      try {
        const [dictionary, versions] = await Promise.all([
          tasksGetConfigDictionary(dictionaryId),
          tasksListDictionaryVersions(dictionaryId),
        ])
        enumDictionariesById.value = {
          ...enumDictionariesById.value,
          [dictionaryId]: dictionary,
        }
        if (versions.length === 0) {
          enumItemsByDict.value = { ...enumItemsByDict.value, [dictionaryId]: [] }
          return
        }
        const latest = versions.reduce((a, b) => (a.version > b.version ? a : b))
        enumLatestVersionIdByDict.value = {
          ...enumLatestVersionIdByDict.value,
          [dictionaryId]: latest.id,
        }
        enumVersionByDict.value = {
          ...enumVersionByDict.value,
          [dictionaryId]: latest.version,
        }
      } catch {
        // non-fatal
      } finally {
        enumDictionaryLoadPromises.delete(dictionaryId)
      }
    })()

    enumDictionaryLoadPromises.set(dictionaryId, loadPromise)
    await loadPromise
  }

  async function searchEnumItemsFor(
    dictionaryId: string,
    search = '',
    selectedCodes: string[] = [],
    limit = 40,
  ) {
    await ensureEnumDictionaryLoaded(dictionaryId)
    const versionId = enumLatestVersionIdByDict.value[dictionaryId]
    if (!versionId) {
      enumItemsByDict.value = { ...enumItemsByDict.value, [dictionaryId]: [] }
      return []
    }
    const nextToken = (enumItemSearchTokenByDict.value[dictionaryId] ?? 0) + 1
    enumItemSearchTokenByDict.value = {
      ...enumItemSearchTokenByDict.value,
      [dictionaryId]: nextToken,
    }
    enumItemSearchLoadingByDict.value = {
      ...enumItemSearchLoadingByDict.value,
      [dictionaryId]: true,
    }
    try {
      const items = await tasksGetDictionaryVersionItems(dictionaryId, versionId, {
        search: search.trim() || undefined,
        limit,
        value_codes: selectedCodes,
      })
      if (enumItemSearchTokenByDict.value[dictionaryId] !== nextToken) {
        return items
      }
      enumItemsByDict.value = { ...enumItemsByDict.value, [dictionaryId]: items }
      mergeKnownEnumItems(dictionaryId, items)
      return items
    } catch {
      return []
    } finally {
      if (enumItemSearchTokenByDict.value[dictionaryId] === nextToken) {
        enumItemSearchLoadingByDict.value = {
          ...enumItemSearchLoadingByDict.value,
          [dictionaryId]: false,
        }
      }
    }
  }

  async function refreshEnumItemsFor(dictionaryId: string, selectedCodes: string[] = []) {
    return searchEnumItemsFor(dictionaryId, '', selectedCodes, 20)
  }

  async function loadEnumItemsFor(dictionaryId: string, selectedCodes: string[] = []) {
    if (
      enumItemsByDict.value[dictionaryId] &&
      enumDictionariesById.value[dictionaryId] &&
      enumLatestVersionIdByDict.value[dictionaryId]
    ) {
      if (selectedCodes.length > 0) {
        await searchEnumItemsFor(dictionaryId, '', selectedCodes, 20)
      }
      return
    }
    await refreshEnumItemsFor(dictionaryId, selectedCodes)
  }

  function enumVersionFor(dictionaryId: string): number | undefined {
    return enumVersionByDict.value[dictionaryId]
  }

  function enumItemCreateLoadingFor(dictionaryId: string): boolean {
    return !!enumItemCreateLoadingByDict.value[dictionaryId]
  }

  function enumItemSearchLoadingFor(dictionaryId: string): boolean {
    return !!enumItemSearchLoadingByDict.value[dictionaryId]
  }

  async function createPublicDictionaryItem(dictionaryId: string, value: string): Promise<EnumDictionaryVersionItem> {
    enumItemCreateLoadingByDict.value = {
      ...enumItemCreateLoadingByDict.value,
      [dictionaryId]: true,
    }
    try {
      const item = await tasksCreatePublicDictionaryItem(dictionaryId, { value })
      mergeKnownEnumItems(dictionaryId, [item])
      await refreshEnumItemsFor(dictionaryId, [item.value_code])
      return item
    } finally {
      enumItemCreateLoadingByDict.value = {
        ...enumItemCreateLoadingByDict.value,
        [dictionaryId]: false,
      }
    }
  }

  function openCreateDialog() {
    createDialogOpen.value = true
  }

  function closeCreateDialog() {
    createDialogOpen.value = false
  }

  async function createTask(payload: CreateTaskPayload): Promise<Task> {
    const task = await tasksCreate(payload)
    selectedTask.value = task
    return task
  }

  async function selectTask(id: string, forceRefresh = false) {
    if (!forceRefresh && selectedTask.value?.id === id) return
    taskLoading.value = true
    taskError.value = null
    try {
      selectedTask.value = await tasksGet(id)
      tasksDescLog('selectTask:loaded', {
        id,
        forceRefresh,
        description: descriptionSignature(selectedTask.value.description),
        updatedAt: selectedTask.value.updated_at,
      })
      await loadFieldsFor(selectedTask.value.template_id)
    } catch (e) {
      taskError.value = e instanceof Error ? e.message : 'Failed to load task'
    } finally {
      taskLoading.value = false
    }
  }

  async function selectTaskByPublicId(publicId: string, forceRefresh = false) {
    if (!forceRefresh && selectedTask.value?.public_id === publicId) return
    taskLoading.value = true
    taskError.value = null
    try {
      selectedTask.value = await tasksGet(publicId)
      tasksDescLog('selectTaskByPublicId:loaded', {
        publicId,
        forceRefresh,
        description: descriptionSignature(selectedTask.value.description),
        updatedAt: selectedTask.value.updated_at,
      })
      await loadFieldsFor(selectedTask.value.template_id)
    } catch (e) {
      taskError.value = e instanceof Error ? e.message : 'Failed to load task'
    } finally {
      taskLoading.value = false
    }
  }

  async function updateTask(id: string, payload: UpdateTaskPayload): Promise<Task> {
    const updated = await tasksUpdate(id, payload)
    selectedTask.value = updated
    return updated
  }

  async function updateTaskTitle(id: string, payload: UpdateTaskTitlePayload): Promise<Task> {
    const updated = await tasksUpdateTaskTitle(id, payload)
    selectedTask.value = updated
    return updated
  }

  async function updateTaskStatus(id: string, statusId: string): Promise<Task> {
    const updated = await tasksUpdateTaskStatus(id, { status_id: statusId })
    if (selectedTask.value?.id === id) {
      selectedTask.value = updated
    }
    return updated
  }

  async function updateTaskDescription(
    id: string,
    description: string | null,
    options?: { forceSnapshot?: boolean },
  ): Promise<Task> {
    tasksDescLog('updateTaskDescription:start', {
      id,
      request: descriptionSignature(description),
      forceSnapshot: options?.forceSnapshot ?? false,
      beforeSelected: selectedTask.value?.id === id
        ? descriptionSignature(selectedTask.value.description)
        : 'not-selected',
    })
    const payload: { description: string | null; force_snapshot?: boolean } = { description }
    if (options?.forceSnapshot) {
      payload.force_snapshot = true
    }
    const updated = await tasksUpdateTaskDescription(id, payload)
    tasksDescLog('updateTaskDescription:response', {
      id,
      response: descriptionSignature(updated.description),
      updatedAt: updated.updated_at,
    })
    if (selectedTask.value?.id === id) {
      selectedTask.value = updated
    } else {
      tasksDescLog('updateTaskDescription:stale-response-ignored', {
        id,
        selectedTaskId: selectedTask.value?.id ?? null,
        response: descriptionSignature(updated.description),
      })
    }
    return updated
  }

  async function listTaskDescriptionHistory(id: string): Promise<TaskDescriptionHistoryItem[]> {
    return tasksListTaskDescriptionHistory(id)
  }

  async function listTaskChangeHistory(
    id: string,
    params?: { cursor?: string; limit?: number },
  ): Promise<TaskChangeHistoryPage> {
    return tasksListTaskChangeHistory(id, params)
  }

  async function updateTaskFieldValue(
    taskId: string,
    fieldId: string,
    payload: {
      value_text?: string | null
      value_number?: string | null
      value_user_id?: string | null
      value_date?: string | null
      value_datetime?: string | null
      value_json?: unknown | null
      enum_dictionary_id?: string | null
      enum_version?: number | null
    },
  ): Promise<TaskFieldValue> {
    const updated = await tasksUpdateTaskFieldValue(taskId, fieldId, payload)
    if (selectedTask.value?.id === taskId) {
      const idx = selectedTask.value.field_values.findIndex(v => v.field_definition_id === fieldId)
      if (idx >= 0) {
        selectedTask.value.field_values[idx] = updated
      } else {
        selectedTask.value.field_values.push(updated)
      }
    }
    return updated
  }

  async function createSubtask(parentId: string, payload: CreateTaskPayload): Promise<Task> {
    const subtask = await tasksCreateSubtask(parentId, payload)
    // Force-refresh the parent so its subtasks list reflects the new entry,
    // even if the parent was the previously selected task.
    await selectTask(parentId, true)
    return subtask
  }

  function clearSelectedTask() {
    selectedTask.value = null
    taskError.value = null
  }

  async function loadTaskList(overrides?: Partial<TaskListParams>) {
    if (overrides) {
      listParams.value = { ...listParams.value, ...overrides }
    }
    taskListLoading.value = true
    taskListError.value = null
    try {
      const res = await tasksListTasks(listParams.value)
      const groups = res.groups ?? []
      taskListGroups.value = groups
      taskListItems.value = res.tasks ?? groups.flatMap(g => g.tasks)
      taskListTotal.value = res.grand_total ?? 0
    } catch (e) {
      taskListError.value = e instanceof Error ? e.message : 'Failed to load tasks'
    } finally {
      taskListLoading.value = false
    }
  }

  async function loadGroupedTaskList(overrides?: Partial<TaskListParams>, limitOverride?: number) {
    if (overrides) {
      listParams.value = { ...listParams.value, ...overrides }
    }
    taskListLoading.value = true
    taskListError.value = null
    try {
      const res = await tasksListGrouped(listFilterParams(), limitOverride)
      const groupedMap = res.groups_by_status ?? {}
      const order = res.status_order ?? []
      const nextByStatus: Record<string, GroupedTaskGroupState> = {}

      for (const statusId of order) {
        const bucket = groupedMap[statusId]
        if (!bucket) continue
        const items = bucket.items ?? []
        nextByStatus[statusId] = {
          ...bucket,
          items,
          next_offset: items.length,
          has_more: items.length < bucket.total,
          loading_more: false,
          load_more_error: null,
        }
      }

      // Keep response robust when map has keys that are not present in status_order.
      for (const [statusId, bucket] of Object.entries(groupedMap)) {
        if (nextByStatus[statusId]) continue
        const items = bucket.items ?? []
        nextByStatus[statusId] = {
          ...bucket,
          items,
          next_offset: items.length,
          has_more: items.length < bucket.total,
          loading_more: false,
          load_more_error: null,
        }
      }

      groupedTaskStatusOrder.value = order
      groupedTaskGroupsByStatus.value = nextByStatus
      groupedTaskPortionLimit.value = res.limit ?? (limitOverride ?? groupedTaskPortionLimit.value)
      taskListTotal.value = res.grand_total ?? 0
    } catch (e) {
      taskListError.value = e instanceof Error ? e.message : 'Failed to load grouped tasks'
    } finally {
      taskListLoading.value = false
    }
  }

  async function loadMoreGroupedStatus(statusId: string) {
    const current = groupedTaskGroupsByStatus.value[statusId]
    if (!current || current.loading_more || !current.has_more) return

    replaceGroupedStatusState(statusId, { ...current, loading_more: true, load_more_error: null })
    try {
      const res = await tasksListStatusPortion(
        statusId,
        listFilterParams(),
        current.next_offset,
        groupedTaskPortionLimit.value,
      )
      const latest = groupedTaskGroupsByStatus.value[statusId]
      if (!latest) return
      replaceGroupedStatusState(statusId, {
        ...latest,
        items: [...latest.items, ...(res.items ?? [])],
        total: res.total ?? latest.total,
        next_offset: res.next_offset ?? (latest.next_offset + (res.items?.length ?? 0)),
        has_more: res.has_more ?? false,
        loading_more: false,
        load_more_error: null,
      })
    } catch (e) {
      const latest = groupedTaskGroupsByStatus.value[statusId]
      if (latest) {
        replaceGroupedStatusState(statusId, {
          ...latest,
          loading_more: false,
          load_more_error: e instanceof Error ? e.message : 'Failed to load more tasks',
        })
      }
    }
  }

  function findGroupedTask(taskID: string): { statusId: string; index: number; item: TaskGroupedItem } | null {
    for (const statusId of groupedTaskStatusOrder.value) {
      const group = groupedTaskGroupsByStatus.value[statusId]
      if (!group) continue
      const index = group.items.findIndex(item => item.id === taskID)
      if (index >= 0) {
        return { statusId, index, item: group.items[index] }
      }
    }
    return null
  }

  function cloneGroupedStatusState(state: GroupedTaskGroupState): GroupedTaskGroupState {
    return {
      ...state,
      status: { ...state.status },
      items: state.items.map(item => ({ ...item, created_by: { ...item.created_by } })),
    }
  }

  function moveGroupedTaskCard(taskID: string, toStatusID: string): boolean {
    const found = findGroupedTask(taskID)
    if (!found || found.statusId === toStatusID) return false

    const fromState = groupedTaskGroupsByStatus.value[found.statusId]
    const toState = groupedTaskGroupsByStatus.value[toStatusID]
    if (!fromState || !toState) return false

    const movedItem: TaskGroupedItem = { ...found.item, status_id: toStatusID }
    const nextFromItems = fromState.items.filter((_, idx) => idx !== found.index)
    const nextFromTotal = Math.max(0, fromState.total - 1)
    const nextToItems = [movedItem, ...toState.items.filter(item => item.id !== movedItem.id)]
    const nextToTotal = toState.total + 1

    groupedTaskGroupsByStatus.value = {
      ...groupedTaskGroupsByStatus.value,
      [found.statusId]: {
        ...fromState,
        items: nextFromItems,
        total: nextFromTotal,
        next_offset: nextFromItems.length,
        has_more: nextFromItems.length < nextFromTotal,
      },
      [toStatusID]: {
        ...toState,
        items: nextToItems,
        total: nextToTotal,
        next_offset: nextToItems.length,
        has_more: nextToItems.length < nextToTotal,
      },
    }
    return true
  }

  function optimisticMoveGroupedTaskCard(taskID: string, toStatusID: string): null | (() => void) {
    const found = findGroupedTask(taskID)
    if (!found || found.statusId === toStatusID) return null
    const fromState = groupedTaskGroupsByStatus.value[found.statusId]
    const toState = groupedTaskGroupsByStatus.value[toStatusID]
    if (!fromState || !toState) return null

    const fromSnapshot = cloneGroupedStatusState(fromState)
    const toSnapshot = cloneGroupedStatusState(toState)
    if (!moveGroupedTaskCard(taskID, toStatusID)) return null

    return () => {
      groupedTaskGroupsByStatus.value = {
        ...groupedTaskGroupsByStatus.value,
        [found.statusId]: fromSnapshot,
        [toStatusID]: toSnapshot,
      }
    }
  }

  function applyTaskStatusChangedToGrouped(taskID: string, toStatusID: string): boolean {
    const moved = moveGroupedTaskCard(taskID, toStatusID)
    if (selectedTask.value?.id === taskID) {
      selectedTask.value = {
        ...selectedTask.value,
        status_id: toStatusID,
      }
    }
    return moved
  }

  function setListParams(partial: Partial<TaskListParams>, mode: TaskListLoadMode = 'list') {
    listParams.value = { ...listParams.value, ...partial, page: 1 }
    if (mode === 'grouped') {
      loadGroupedTaskList()
      return
    }
    loadTaskList()
  }

  function resetListParams(mode: TaskListLoadMode = 'list') {
    listParams.value = { ...DEFAULT_LIST_PARAMS }
    if (mode === 'grouped') {
      loadGroupedTaskList()
      return
    }
    loadTaskList()
  }

  function resetRuntimeState() {
    templates.value = []
    statuses.value = []
    fieldsByTemplate.value = {}
    configLoaded.value = false
    configLoading.value = false
    configError.value = null
    configLoadPromise = null

    users.value = []
    usersLoaded.value = false
    enumDictionariesById.value = {}
    filterableEnumDictionaries.value = []
    enumItemsByDict.value = {}
    enumKnownItemsByDict.value = {}
    enumVersionByDict.value = {}
    enumLatestVersionIdByDict.value = {}
    enumItemCreateLoadingByDict.value = {}
    enumItemSearchLoadingByDict.value = {}
    enumItemSearchTokenByDict.value = {}
    enumDictionaryLoadPromises.clear()

    selectedTask.value = null
    taskLoading.value = false
    taskError.value = null
    createDialogOpen.value = false

    taskListGroups.value = []
    taskListItems.value = []
    groupedTaskStatusOrder.value = []
    groupedTaskGroupsByStatus.value = {}
    groupedTaskPortionLimit.value = 50
    taskListTotal.value = 0
    taskListLoading.value = false
    taskListError.value = null
    listParams.value = { ...DEFAULT_LIST_PARAMS }
  }

  const taskListGroupsReadonly = readonly(taskListGroups)
  const groupedTaskStatusOrderReadonly = readonly(groupedTaskStatusOrder)
  const groupedTaskGroupsByStatusReadonly = readonly(groupedTaskGroupsByStatus)
  const groupedTaskPortionLimitReadonly = readonly(groupedTaskPortionLimit)
  const listParamsReadonly = readonly(listParams)

  return {
    // state
    templates,
    statuses,
    fieldsByTemplate,
    configLoaded,
    configLoading,
    configError,
    users,
    enumDictionariesById,
    filterableEnumDictionaries,
    enumItemsByDict,
    enumKnownItemsByDict,
    selectedTask,
    taskLoading,
    taskError,
    createDialogOpen,
    taskList,
    taskListGroups: taskListGroupsReadonly,
    groupedTaskStatusOrder: groupedTaskStatusOrderReadonly,
    groupedTaskGroupsByStatus: groupedTaskGroupsByStatusReadonly,
    groupedTaskPortionLimit: groupedTaskPortionLimitReadonly,
    taskListTotal,
    taskListLoading,
    taskListError,
    listParams: listParamsReadonly,
    // derived
    activeTemplates,
    activeStatuses,
    allStatuses,
    activeFieldsFor,
    assigneeFieldIds,
    statusById,
    templateById,
    enumDictionaryFor,
    enumItemsFor,
    enumKnownItemsFor,
    enumVersionFor,
    enumItemCreateLoadingFor,
    enumItemSearchLoadingFor,
    // actions
    loadConfig,
    loadFieldsFor,
    loadAllTemplateFields,
    loadUsers,
    loadFilterableDictionaries,
    loadEnumItemsFor,
    searchEnumItemsFor,
    refreshEnumItemsFor,
    createPublicDictionaryItem,
    openCreateDialog,
    closeCreateDialog,
    createTask,
    selectTask,
    selectTaskByPublicId,
    updateTask,
    updateTaskTitle,
    updateTaskStatus,
    updateTaskDescription,
    listTaskDescriptionHistory,
    listTaskChangeHistory,
    updateTaskFieldValue,
    createSubtask,
    clearSelectedTask,
    loadTaskList,
    loadGroupedTaskList,
    loadMoreGroupedStatus,
    optimisticMoveGroupedTaskCard,
    applyTaskStatusChangedToGrouped,
    setListParams,
    resetListParams,
    resetRuntimeState,
  }
})
