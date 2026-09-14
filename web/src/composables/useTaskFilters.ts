import { ref } from 'vue'

const searchInput = ref('')
const filtersVisible = ref(false)
const selectedStatusIds = ref<string[]>([])
const selectedTemplateId = ref<string | null>(null)
const selectedAssigneeIds = ref<string[]>([])
const selectedDictionaryEnumCodes = ref<Record<string, string[]>>({})
const createdFrom = ref('')
const createdTo = ref('')
const showSubtasks = ref(false)

export function useTaskFilters() {
  return {
    searchInput,
    filtersVisible,
    selectedStatusIds,
    selectedTemplateId,
    selectedAssigneeIds,
    selectedDictionaryEnumCodes,
    createdFrom,
    createdTo,
    showSubtasks,
  }
}
