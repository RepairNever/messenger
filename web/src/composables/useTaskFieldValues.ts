import type { TaskFieldDefinition, TaskFieldValueInput } from '@/services/http/tasksApi'

/**
 * Converts a map of raw field values (keyed by field definition ID) into the
 * array format expected by the task create/update API.
 *
 * @param getEnumVersion - Returns the currently loaded version number for a
 *   given dictionary ID. Required so enum/multi_enum fields can include
 *   enum_version, satisfying the backend FK constraint.
 */
export function buildFieldValues(
  fields: TaskFieldDefinition[],
  values: Record<string, unknown>,
  getEnumVersion: (dictionaryId: string) => number | undefined,
): TaskFieldValueInput[] {
  return fields.map((field): TaskFieldValueInput => {
    const raw = values[field.id]
    const base: TaskFieldValueInput = { field_definition_id: field.id }

    if (raw === null || raw === undefined || raw === '') return base

    switch (field.type) {
      case 'text':
        return { ...base, value_text: raw as string }
      case 'number':
        return { ...base, value_number: raw as string }
      case 'date':
        return { ...base, value_date: raw as string }
      case 'datetime':
        return { ...base, value_datetime: raw as string }
      case 'user':
        return { ...base, value_user_id: raw as string }
      case 'users':
        return { ...base, value_json: raw }
      case 'enum':
        return {
          ...base,
          value_text: raw as string,
          enum_dictionary_id: field.enum_dictionary_id ?? undefined,
          enum_version: field.enum_dictionary_id
            ? getEnumVersion(field.enum_dictionary_id)
            : undefined,
        }
      case 'multi_enum':
        return {
          ...base,
          value_json: raw,
          enum_dictionary_id: field.enum_dictionary_id ?? undefined,
          enum_version: field.enum_dictionary_id
            ? getEnumVersion(field.enum_dictionary_id)
            : undefined,
        }
    }
  })
}

/**
 * Returns the IDs of required fields that have no value.
 * An empty array means all required fields are filled.
 */
export function missingRequiredFields(
  fields: TaskFieldDefinition[],
  values: Record<string, unknown>,
): string[] {
  return fields
    .filter(f => f.required)
    .filter(f => {
      const v = values[f.id]
      if (v === null || v === undefined || v === '') return true
      if (Array.isArray(v) && v.length === 0) return true
      return false
    })
    .map(f => f.id)
}
