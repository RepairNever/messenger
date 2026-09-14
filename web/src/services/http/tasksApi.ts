import { AxiosError } from 'axios'
import { createAuthenticatedClient } from './client'
import type { UserCustomStatusDto } from '@/types/userStatus'

const http = createAuthenticatedClient()
const DEBUG_TASKS_API_DESC = import.meta.env.DEV

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

function tasksApiDescLog(event: string, payload: Record<string, unknown>) {
  if (!DEBUG_TASKS_API_DESC) return
  console.debug('[tasks-api-desc]', event, payload)
}

// Base URL used to construct direct download links.
// The download endpoint streams through the backend so the Bearer token is
// handled via an Axios request rather than a plain anchor href.
export function tasksAttachmentDownloadUrl(taskId: string, attachmentId: string): string {
  return `/api/tasks/${taskId}/attachments/${attachmentId}/download`
}

export class TasksApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
    this.name = 'TasksApiError'
  }
}

export class TasksApiConflictError<T = unknown> extends TasksApiError {
  constructor(message: string, status: number, public readonly details: T) {
    super(message, status)
    this.name = 'TasksApiConflictError'
  }
}

function handleError(e: unknown): never {
  if (e instanceof AxiosError && e.response) {
    const msg: string = e.response.data?.error ?? e.response.statusText
    if (e.response.status === 409) {
      throw new TasksApiConflictError(msg, e.response.status, e.response.data)
    }
    throw new TasksApiError(msg, e.response.status)
  }
  throw new TasksApiError('Network error', 0)
}

// ---- Types ----

export interface TaskTemplate {
  id: string
  prefix: string
  sort_order: number
  deleted_at: string | null
  created_at: string
  updated_at: string
  created_by: string
  updated_by: string
}

export interface TaskStatus {
  id: string
  code: string
  name: string
  sort_order: number
  deleted_at: string | null
  created_at: string
  updated_at: string
  created_by: string
}

export interface EnumDictionary {
  id: string
  code: string
  name: string
  is_public: boolean
  participates_in_filtration: boolean
  current_version: number
  created_at: string
  updated_at: string
}

export interface EnumDictionaryVersion {
  id: string
  dictionary_id: string
  version: number
  created_at: string
  created_by: string
}

export interface EnumDictionaryVersionItem {
  id: string
  dictionary_version_id: string
  value_code: string
  value_name: string
  sort_order: number
  is_active: boolean
}

// ---- Templates ----

export async function tasksListTemplates(includeDeleted = false): Promise<TaskTemplate[]> {
  try {
    const { data } = await http.get<TaskTemplate[]>('/api/tasks/config/templates', {
      params: includeDeleted ? { include_deleted: true } : undefined,
    })
    return data
  } catch (e) { handleError(e) }
}

export async function tasksCreateTemplate(payload: { prefix: string; sort_order?: number }): Promise<TaskTemplate> {
  try {
    const { data } = await http.post<TaskTemplate>('/api/admin/task-templates', payload)
    return data
  } catch (e) { handleError(e) }
}

export async function tasksUpdateTemplate(
  id: string,
  payload: { prefix: string; sort_order?: number },
): Promise<TaskTemplate> {
  try {
    const { data } = await http.patch<TaskTemplate>(`/api/admin/task-templates/${id}`, payload)
    return data
  } catch (e) { handleError(e) }
}

export async function tasksDeleteTemplate(id: string): Promise<TaskTemplate> {
  try {
    const { data } = await http.delete<TaskTemplate>(`/api/admin/task-templates/${id}`)
    return data
  } catch (e) { handleError(e) }
}

export async function tasksReorderTemplates(ids: string[]): Promise<void> {
  try {
    await http.post('/api/admin/task-templates/reorder', { ids })
  } catch (e) { handleError(e) }
}

// ---- Statuses ----

export async function tasksListStatuses(includeDeleted = false): Promise<TaskStatus[]> {
  try {
    const { data } = await http.get<TaskStatus[]>('/api/tasks/config/statuses', {
      params: includeDeleted ? { include_deleted: true } : undefined,
    })
    return data
  } catch (e) { handleError(e) }
}

export async function tasksCreateStatus(payload: { code: string; name: string; sort_order?: number }): Promise<TaskStatus> {
  try {
    const { data } = await http.post<TaskStatus>('/api/admin/task-statuses', payload)
    return data
  } catch (e) { handleError(e) }
}

export async function tasksUpdateStatus(id: string, payload: { code: string; name: string }): Promise<TaskStatus> {
  try {
    const { data } = await http.patch<TaskStatus>(`/api/admin/task-statuses/${id}`, payload)
    return data
  } catch (e) { handleError(e) }
}

export async function tasksDeleteStatus(id: string): Promise<TaskStatus> {
  try {
    const { data } = await http.delete<TaskStatus>(`/api/admin/task-statuses/${id}`)
    return data
  } catch (e) { handleError(e) }
}

export async function tasksReorderStatuses(ids: string[]): Promise<void> {
  try {
    await http.post('/api/admin/task-statuses/reorder', { ids })
  } catch (e) { handleError(e) }
}

// ---- Enum Dictionaries ----

export async function tasksListDictionaries(): Promise<EnumDictionary[]> {
  try {
    const { data } = await http.get<EnumDictionary[]>('/api/admin/enums')
    return data
  } catch (e) { handleError(e) }
}

export async function tasksCreateDictionary(payload: {
  code: string
  name: string
  is_public?: boolean
  participates_in_filtration?: boolean
}): Promise<EnumDictionary> {
  try {
    const { data } = await http.post<EnumDictionary>('/api/admin/enums', payload)
    return data
  } catch (e) { handleError(e) }
}

export async function tasksGetDictionary(id: string): Promise<EnumDictionary> {
  try {
    const { data } = await http.get<EnumDictionary>(`/api/admin/enums/${id}`)
    return data
  } catch (e) { handleError(e) }
}

export async function tasksUpdateDictionary(
  id: string,
  payload: { is_public: boolean; participates_in_filtration: boolean },
): Promise<EnumDictionary> {
  try {
    const { data } = await http.patch<EnumDictionary>(`/api/admin/enums/${id}`, payload)
    return data
  } catch (e) { handleError(e) }
}

export async function tasksGetConfigDictionary(id: string): Promise<EnumDictionary> {
  try {
    const { data } = await http.get<EnumDictionary>(`/api/tasks/config/enums/${id}`)
    return data
  } catch (e) { handleError(e) }
}

export async function tasksListFilterableDictionaries(): Promise<EnumDictionary[]> {
  try {
    const { data } = await http.get<EnumDictionary[]>('/api/tasks/config/enums')
    return data
  } catch (e) { handleError(e) }
}

export async function tasksListDictionaryVersions(id: string): Promise<EnumDictionaryVersion[]> {
  try {
    const { data } = await http.get<EnumDictionaryVersion[]>(`/api/tasks/config/enums/${id}/versions`)
    return data
  } catch (e) { handleError(e) }
}

export async function tasksCreateDictionaryVersion(
  id: string,
  items: { value_code: string; value_name: string; sort_order: number; is_active: boolean }[],
): Promise<EnumDictionaryVersion> {
  try {
    const { data } = await http.post<EnumDictionaryVersion>(`/api/admin/enums/${id}/versions`, { items })
    return data
  } catch (e) { handleError(e) }
}

export async function tasksGetDictionaryVersionItems(
  dictId: string,
  versionId: string,
  params?: { search?: string; limit?: number; value_codes?: string[] },
): Promise<EnumDictionaryVersionItem[]> {
  try {
    const query = new URLSearchParams()
    if (params?.search) query.set('search', params.search)
    if (params?.limit && params.limit > 0) query.set('limit', String(params.limit))
    for (const code of params?.value_codes ?? []) {
      query.append('value_code', code)
    }
    const { data } = await http.get<EnumDictionaryVersionItem[]>(
      `/api/tasks/config/enums/${dictId}/versions/${versionId}${query.size > 0 ? `?${query.toString()}` : ''}`,
    )
    return data
  } catch (e) { handleError(e) }
}

export async function tasksCreatePublicDictionaryItem(
  dictId: string,
  payload: { value: string },
): Promise<EnumDictionaryVersionItem> {
  try {
    const { data } = await http.post<EnumDictionaryVersionItem>(`/api/tasks/config/enums/${dictId}/items`, payload)
    return data
  } catch (e) { handleError(e) }
}

// ---- Field definitions ----

export type FieldType = 'text' | 'number' | 'user' | 'users' | 'enum' | 'multi_enum' | 'date' | 'datetime'

export interface TaskFieldDefinition {
  id: string
  template_id: string
  code: string
  name: string
  type: FieldType
  required: boolean
  sort_order: number
  enum_dictionary_id: string | null
  field_role: 'assignee' | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export interface CreateFieldPayload {
  code: string
  name: string
  type: FieldType
  sort_order: number
  required?: boolean
  enum_dictionary_id?: string | null
  field_role?: 'assignee' | null
}

export async function tasksListFields(templateId: string, includeDeleted = false): Promise<TaskFieldDefinition[]> {
  try {
    const { data } = await http.get<TaskFieldDefinition[]>(
      `/api/tasks/config/templates/${templateId}/fields`,
      { params: includeDeleted ? { include_deleted: true } : undefined },
    )
    return data
  } catch (e) { handleError(e) }
}

export async function tasksCreateField(templateId: string, payload: CreateFieldPayload): Promise<TaskFieldDefinition> {
  try {
    const { data } = await http.post<TaskFieldDefinition>(
      `/api/admin/task-templates/${templateId}/fields`,
      payload,
    )
    return data
  } catch (e) { handleError(e) }
}

export async function tasksUpdateField(
  templateId: string,
  fieldId: string,
  payload: { name: string; required: boolean },
): Promise<TaskFieldDefinition> {
  try {
    const { data } = await http.patch<TaskFieldDefinition>(
      `/api/admin/task-templates/${templateId}/fields/${fieldId}`,
      payload,
    )
    return data
  } catch (e) { handleError(e) }
}

export async function tasksDeleteField(templateId: string, fieldId: string): Promise<TaskFieldDefinition> {
  try {
    const { data } = await http.delete<TaskFieldDefinition>(
      `/api/admin/task-templates/${templateId}/fields/${fieldId}`,
    )
    return data
  } catch (e) { handleError(e) }
}

export async function tasksReorderFields(templateId: string, ids: string[]): Promise<void> {
  try {
    await http.post(`/api/admin/task-templates/${templateId}/fields/reorder`, { ids })
  } catch (e) { handleError(e) }
}

// ---- Users (non-admin public listing) ----

export interface TaskUser {
  id: string
  display_name: string
  email: string
  avatar_url?: string
  custom_status?: UserCustomStatusDto | null
}

export async function tasksListUsers(): Promise<TaskUser[]> {
  try {
    const { data } = await http.get<TaskUser[]>('/api/users')
    return data
  } catch (e) { handleError(e) }
}

// ---- Tasks ----

export interface TaskFieldValue {
  id: string
  task_id: string
  field_definition_id: string
  value_text: string | null
  value_number: string | null
  value_user_id: string | null
  value_date: string | null
  value_datetime: string | null
  value_json: unknown | null
  enum_dictionary_id: string | null
  enum_version: number | null
  created_at: string
  updated_at: string
}

export interface TaskAssigneeSummary {
  id: string
  display_name: string
  email: string
  avatar_url: string
  custom_status?: UserCustomStatusDto | null
}

export interface TaskSubtaskSummary {
  id: string
  public_id: string
  template_id: string
  template_snapshot_prefix: string
  sequence_number: number
  title: string
  description: string | null
  status_id: string
  parent_task_id: string | null
  created_by: string
  updated_by: string
  created_at: string
  updated_at: string
  assignees: TaskAssigneeSummary[]
}

export interface Task {
  id: string
  public_id: string
  template_id: string
  template_snapshot_prefix: string
  sequence_number: number
  title: string
  description: string | null
  status_id: string
  parent_task_id: string | null
  parent_public_id?: string | null
  created_by: string
  updated_by: string
  created_at: string
  updated_at: string
  field_values: TaskFieldValue[]
  subtasks: TaskSubtaskSummary[]
}

export interface TaskFieldValueInput {
  field_definition_id: string
  value_text?: string | null
  value_number?: string | null
  value_user_id?: string | null
  value_date?: string | null
  value_datetime?: string | null
  value_json?: unknown | null
  enum_dictionary_id?: string | null
  enum_version?: number | null
}

export interface CreateTaskPayload {
  template_id: string
  title: string
  description?: string | null
  status_id: string
  field_values?: TaskFieldValueInput[]
  staged_attachment_ids?: string[]
}

export interface UpdateTaskPayload {
  title: string
  description?: string | null
  status_id: string
  field_values?: TaskFieldValueInput[]
}

export interface UpdateTaskTitlePayload {
  title: string
  if_unmodified_since: string
}

export interface TaskTitleConflictResponse {
  error: string
  latest: {
    title: string
    updated_at: string
  }
}

export interface UpdateTaskStatusPayload {
  status_id: string
}

export interface UpdateTaskDescriptionPayload {
  description?: string | null
  force_snapshot?: boolean
}

export interface TaskDescriptionHistoryEditor {
  id: string
  display_name: string
  avatar_url: string
  custom_status?: UserCustomStatusDto | null
}

export interface TaskDescriptionHistoryItem {
  public_id: string
  title: string
  description: string | null
  edited_by: string
  created_at: string
  editor: TaskDescriptionHistoryEditor
}

export interface TaskHistoryActor {
  id: string
  display_name: string
  avatar_url: string
  custom_status?: UserCustomStatusDto | null
}

export interface TaskChangeHistoryItem {
  id: string
  change_kind: 'created' | 'field'
  field_key: string
  field_name: string
  field_type: string
  before_value: unknown
  after_value: unknown
  created_at: string
  actor: TaskHistoryActor
}

export interface TaskChangeHistoryPage {
  items: TaskChangeHistoryItem[]
  next_cursor?: string
}

export interface UpdateTaskFieldValuePayload {
  value_text?: string | null
  value_number?: string | null
  value_user_id?: string | null
  value_date?: string | null
  value_datetime?: string | null
  value_json?: unknown | null
  enum_dictionary_id?: string | null
  enum_version?: number | null
}

export async function tasksCreate(payload: CreateTaskPayload): Promise<Task> {
  try {
    const { data } = await http.post<Task>('/api/tasks', payload)
    return data
  } catch (e) { handleError(e) }
}

export async function tasksGet(id: string): Promise<Task> {
  try {
    const { data } = await http.get<Task>(`/api/tasks/${id}`)
    return data
  } catch (e) { handleError(e) }
}

export async function tasksUpdate(id: string, payload: UpdateTaskPayload): Promise<Task> {
  try {
    const { data } = await http.patch<Task>(`/api/tasks/${id}`, payload)
    return data
  } catch (e) { handleError(e) }
}

export async function tasksUpdateTaskTitle(id: string, payload: UpdateTaskTitlePayload): Promise<Task> {
  try {
    const { data } = await http.patch<Task>(`/api/tasks/${id}/title`, payload, {
      headers: {
        'If-Unmodified-Since': payload.if_unmodified_since,
      },
    })
    return data
  } catch (e) { handleError(e) }
}

export async function tasksUpdateTaskStatus(id: string, payload: UpdateTaskStatusPayload): Promise<Task> {
  try {
    const { data } = await http.patch<Task>(`/api/tasks/${id}/status`, payload)
    return data
  } catch (e) { handleError(e) }
}

export async function tasksUpdateTaskDescription(id: string, payload: UpdateTaskDescriptionPayload): Promise<Task> {
  try {
    tasksApiDescLog('patch:start', {
      id,
      request: descriptionSignature(payload.description),
    })
    const { data } = await http.patch<Task>(`/api/tasks/${id}/description`, payload)
    tasksApiDescLog('patch:response', {
      id,
      response: descriptionSignature(data.description),
      updatedAt: data.updated_at,
    })
    return data
  } catch (e) { handleError(e) }
}

export async function tasksListTaskDescriptionHistory(id: string): Promise<TaskDescriptionHistoryItem[]> {
  try {
    const { data } = await http.get<TaskDescriptionHistoryItem[]>(`/api/tasks/${id}/description/history`)
    return data
  } catch (e) { handleError(e) }
}

export async function tasksListTaskChangeHistory(
  id: string,
  params?: { cursor?: string; limit?: number },
): Promise<TaskChangeHistoryPage> {
  try {
    const { data } = await http.get<TaskChangeHistoryPage>(`/api/tasks/${id}/history`, { params })
    return data
  } catch (e) { handleError(e) }
}

export async function tasksUpdateTaskFieldValue(
  taskId: string,
  fieldId: string,
  payload: UpdateTaskFieldValuePayload,
): Promise<TaskFieldValue> {
  try {
    const { data } = await http.patch<TaskFieldValue>(`/api/tasks/${taskId}/fields/${fieldId}`, payload)
    return data
  } catch (e) { handleError(e) }
}

export async function tasksCreateSubtask(parentId: string, payload: CreateTaskPayload): Promise<Task> {
  try {
    const { data } = await http.post<Task>(`/api/tasks/${parentId}/subtasks`, payload)
    return data
  } catch (e) { handleError(e) }
}

// ---- Task list ----

export type SortBy = 'id' | 'title' | 'status' | 'created_at' | 'updated_at'
export type SortOrder = 'asc' | 'desc'

// TaskListItem mirrors the backend TaskRow fields used in list views.
export interface TaskListItem {
  id: string
  public_id: string
  title: string
  template_id: string
  template_snapshot_prefix: string
  status_id: string
  created_at: string
  updated_at: string
}

// FieldFilter mirrors the backend field_<uuid>_user / field_<uuid>_enum params.
export interface FieldFilter {
  field_definition_id: string
  user_ids?: string[]
  enum_codes?: string[]
  date_from?: string
  date_to?: string
}

export interface DictionaryFilter {
  dictionary_id: string
  enum_codes: string[]
}

export interface TaskListParams {
  search?: string
  // Repeatable: maps to multiple status_id= query params
  status_ids?: string[]
  // Repeatable: maps to multiple prefix= query params
  prefixes?: string[]
  // Include subtasks alongside top-level tasks when true; default hides them.
  include_subtasks?: boolean
  // Created-at date bounds in YYYY-MM-DD form.
  created_from?: string
  created_to?: string
  // Per-field custom filters (field_<uuid>_user, field_<uuid>_enum, etc.)
  field_filters?: FieldFilter[]
  // Per-dictionary enum filters (dictionary_<uuid>_enum).
  dictionary_filters?: DictionaryFilter[]
  sort_by?: SortBy
  sort_order?: SortOrder
  page?: number
  page_size?: number
}

export type TaskFilterPayload = Pick<
  TaskListParams,
  'search' | 'status_ids' | 'prefixes' | 'include_subtasks' | 'created_from' | 'created_to' | 'field_filters' | 'dictionary_filters'
>

// Mirrors backend StatusRow (subset used in list)
export interface TaskListStatus {
  id: string
  code: string
  name: string
  sort_order: number
}

// Mirrors backend TaskGroup
export interface TaskListGroup {
  status: TaskListStatus
  tasks: TaskListItem[]
  total: number
  page: number
  page_size: number
}

// Mirrors backend ListTasksResponse
export interface TaskListResponse {
  tasks?: TaskListItem[]
  groups: TaskListGroup[]
  grand_total: number
}

export interface TaskGroupedItemCreator {
  id: string
  display_name: string
  avatar_url: string
  custom_status?: UserCustomStatusDto | null
}

export interface TaskGroupedItem {
  id: string
  public_id: string
  title: string
  description_preview: string
  status_id: string
  created_at: string
  updated_at: string
  created_by: TaskGroupedItemCreator
}

export interface TaskGroupedStatusBucket {
  status: TaskListStatus
  items: TaskGroupedItem[]
  total: number
}

export interface TaskListGroupedResponse {
  status_order: string[]
  groups_by_status: Record<string, TaskGroupedStatusBucket>
  grand_total: number
  limit: number
}

export interface TaskStatusPortionResponse {
  status_id: string
  items: TaskGroupedItem[]
  total: number
  offset: number
  limit: number
  next_offset: number
  has_more: boolean
}

function buildTaskFilterQuery(params: TaskListParams): URLSearchParams {
  const q = new URLSearchParams()
  if (params.search) q.set('search', params.search)

  params.status_ids?.forEach(id => q.append('status_id', id))
  params.prefixes?.forEach(p => q.append('prefix', p))
  // Serialize the boolean explicitly when provided so the client does not
  // depend on the backend default for subtask visibility.
  if (params.include_subtasks != null) q.set('include_subtasks', String(params.include_subtasks))
  if (params.created_from) q.set('created_from', params.created_from)
  if (params.created_to) q.set('created_to', params.created_to)

  params.field_filters?.forEach(ff => {
    ff.user_ids?.forEach(uid => q.append(`field_${ff.field_definition_id}_user`, uid))
    ff.enum_codes?.forEach(code => q.append(`field_${ff.field_definition_id}_enum`, code))
    if (ff.date_from) q.set(`field_${ff.field_definition_id}_date_from`, ff.date_from)
    if (ff.date_to) q.set(`field_${ff.field_definition_id}_date_to`, ff.date_to)
  })
  params.dictionary_filters?.forEach(df => {
    df.enum_codes.forEach(code => q.append(`dictionary_${df.dictionary_id}_enum`, code))
  })
  return q
}

export async function tasksListTasks(params: TaskListParams = {}): Promise<TaskListResponse> {
  try {
    const q = buildTaskFilterQuery(params)
    if (params.sort_by) q.set('sort_by', params.sort_by)
    if (params.sort_order) q.set('sort_order', params.sort_order)
    if (params.page) q.set('page', String(params.page))
    if (params.page_size) q.set('page_size', String(params.page_size))

    const { data } = await http.get<TaskListResponse>('/api/tasks', { params: q })
    return data
  } catch (e) { handleError(e) }
}

export async function tasksListGrouped(params: TaskListParams = {}, limit?: number): Promise<TaskListGroupedResponse> {
  try {
    const q = buildTaskFilterQuery(params)
    if (limit) q.set('limit', String(limit))
    const { data } = await http.get<TaskListGroupedResponse>('/api/tasks/grouped', { params: q })
    return data
  } catch (e) { handleError(e) }
}

export async function tasksListStatusPortion(
  statusId: string,
  params: TaskListParams = {},
  offset = 0,
  limit?: number,
): Promise<TaskStatusPortionResponse> {
  try {
    const q = buildTaskFilterQuery(params)
    q.set('offset', String(offset))
    if (limit) q.set('limit', String(limit))
    const { data } = await http.get<TaskStatusPortionResponse>(
      `/api/tasks/status/${encodeURIComponent(statusId)}/portion`,
      { params: q },
    )
    return data
  } catch (e) { handleError(e) }
}

// =========================================================
// Phase 6: Attachments
// =========================================================

export interface TaskAttachment {
  id: string
  task_id: string
  file_name: string
  file_size: number
  mime_type: string
  // storage_key is intentionally absent: the backend does not serialise it.
  // Downloads go through /api/tasks/:id/attachments/:aid/download (proxied).
  uploaded_by: string
  created_at: string
}

export interface TaskAttachmentUploadError {
  file_name: string
  message: string
}

export interface TaskAttachmentUploadResult {
  attachments: TaskAttachment[]
  errors: TaskAttachmentUploadError[]
}

export interface TaskStagedAttachment {
  id: string
  file_name: string
  file_size: number
  mime_type: string
  uploaded_by: string
  created_at: string
}

export async function tasksUploadStagedAttachment(file: File): Promise<TaskStagedAttachment> {
  try {
    const form = new FormData()
    form.append('file', file, file.name)
    const { data } = await http.post<TaskStagedAttachment>(
      '/api/tasks/staged-attachments',
      form,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    )
    return data
  } catch (e) { handleError(e) }
}

export async function tasksDeleteStagedAttachment(attachmentId: string): Promise<void> {
  try {
    await http.delete(`/api/tasks/staged-attachments/${attachmentId}`)
  } catch (e) { handleError(e) }
}

export async function tasksFetchStagedAttachmentBlob(attachmentId: string): Promise<Blob> {
  try {
    const { data } = await http.get<Blob>(
      `/api/tasks/staged-attachments/${attachmentId}/download`,
      { responseType: 'blob' },
    )
    return data
  } catch (e) { handleError(e) }
}

export async function tasksListAttachments(taskId: string): Promise<TaskAttachment[]> {
  try {
    const { data } = await http.get<TaskAttachment[]>(`/api/tasks/${taskId}/attachments`)
    return data
  } catch (e) { handleError(e) }
}

export async function tasksUploadAttachment(taskId: string, file: File): Promise<TaskAttachment> {
  try {
    const form = new FormData()
    form.append('file', file, file.name)
    const { data } = await http.post<TaskAttachment>(
      `/api/tasks/${taskId}/attachments`,
      form,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    )
    return data
  } catch (e) { handleError(e) }
}

/** Upload all files selected in one task-attachment action as one audit event. */
export async function tasksUploadAttachments(
  taskId: string,
  files: File[],
): Promise<TaskAttachmentUploadResult> {
  try {
    const form = new FormData()
    for (const file of files) form.append('files', file, file.name)
    const { data } = await http.post<TaskAttachmentUploadResult>(
      `/api/tasks/${taskId}/attachments/batch`,
      form,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    )
    return data
  } catch (e) { handleError(e) }
}

export async function tasksDeleteAttachment(taskId: string, attachmentId: string): Promise<void> {
  try {
    await http.delete(`/api/tasks/${taskId}/attachments/${attachmentId}`)
  } catch (e) { handleError(e) }
}

export async function tasksFetchAttachmentBlob(taskId: string, attachmentId: string): Promise<Blob> {
  try {
    const { data } = await http.get<Blob>(
      `/api/tasks/${taskId}/attachments/${attachmentId}/download`,
      { responseType: 'blob' },
    )
    return data
  } catch (e) { handleError(e) }
}

/** Download an attachment as a Blob and trigger a browser save dialog. */
export async function tasksDownloadAttachment(taskId: string, attachmentId: string, fileName: string): Promise<void> {
  try {
    const data = await tasksFetchAttachmentBlob(taskId, attachmentId)
    const url = URL.createObjectURL(data)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) { handleError(e) }
}

// =========================================================
// Phase 6: Comments
// =========================================================

export interface TaskComment {
  id: string
  task_id: string
  author_id: string
  thread_root_message_id?: string
  thread_reply_count?: number
  body: string
  created_at: string
  updated_at: string
  attachments: TaskCommentAttachment[]
}

export interface TaskCommentThread {
  conversation_id: string
  thread_root_message_id: string
  reply_count: number
}

export interface TaskCommentAttachment {
  id: string
  task_id: string
  comment_id?: string
  file_name: string
  file_size: number
  mime_type: string
  uploaded_by: string
  created_at: string
}

export async function tasksListComments(taskId: string): Promise<TaskComment[]> {
  try {
    const { data } = await http.get<TaskComment[]>(`/api/tasks/${taskId}/comments`)
    return data
  } catch (e) { handleError(e) }
}

export async function tasksCreateComment(
  taskId: string,
  payload: { body: string; attachment_ids?: string[] },
): Promise<TaskComment> {
  try {
    const { data } = await http.post<TaskComment>(`/api/tasks/${taskId}/comments`, payload)
    return data
  } catch (e) { handleError(e) }
}

export async function tasksUpdateComment(
  taskId: string,
  commentId: string,
  payload: { body: string; attachment_ids?: string[] },
): Promise<TaskComment> {
  try {
    const { data } = await http.put<TaskComment>(`/api/tasks/${taskId}/comments/${commentId}`, payload)
    return data
  } catch (e) { handleError(e) }
}

export async function tasksEnsureCommentThread(taskId: string, commentId: string): Promise<TaskCommentThread> {
  try {
    const { data } = await http.post<TaskCommentThread>(`/api/tasks/${taskId}/comments/${commentId}/thread`)
    return data
  } catch (e) { handleError(e) }
}

export async function tasksUploadCommentAttachment(taskId: string, file: File): Promise<TaskCommentAttachment> {
  try {
    const form = new FormData()
    form.append('file', file, file.name)
    const { data } = await http.post<TaskCommentAttachment>(
      `/api/tasks/${taskId}/comments/attachments`,
      form,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    )
    return data
  } catch (e) { handleError(e) }
}

export async function tasksDeleteCommentAttachment(taskId: string, attachmentId: string): Promise<void> {
  try {
    await http.delete(`/api/tasks/${taskId}/comments/attachments/${attachmentId}`)
  } catch (e) { handleError(e) }
}

export async function tasksFetchCommentAttachmentBlob(taskId: string, commentId: string, attachmentId: string): Promise<Blob> {
  try {
    const { data } = await http.get<Blob>(
      `/api/tasks/${taskId}/comments/${commentId}/attachments/${attachmentId}/download`,
      { responseType: 'blob' },
    )
    return data
  } catch (e) { handleError(e) }
}
