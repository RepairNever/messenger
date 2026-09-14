import { reactive, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TaskTrackerFilters from '@/components/tasks/TaskTrackerFilters.vue'

const filtersMock = {
  searchInput: ref(''),
  filtersVisible: ref(false),
  selectedStatusIds: ref<string[]>([]),
  selectedTemplateId: ref<string | null>(null),
  selectedAssigneeIds: ref<string[]>([]),
  selectedDictionaryEnumCodes: ref<Record<string, string[]>>({}),
  createdFrom: ref(''),
  createdTo: ref(''),
  showSubtasks: ref(false),
}

vi.mock('@/composables/useTaskFilters', () => ({
  useTaskFilters: () => filtersMock,
}))

const tasksStoreMock = reactive({
  activeStatuses: [{ id: 'st-1', name: 'Todo' }],
  activeTemplates: [{ id: 'tpl-1', prefix: 'BUG' }],
  filterableEnumDictionaries: [
    {
      id: 'dict-1',
      code: 'priority',
      name: 'Priority',
      is_public: false,
      participates_in_filtration: true,
      current_version: 1,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  ],
  assigneeFieldIds: ['fld-assignee'],
  users: [{ id: 'u-1', display_name: 'Ada', email: 'ada@example.com', avatar_url: '' }],
  loadConfig: vi.fn(async () => { }),
  loadAllTemplateFields: vi.fn(async () => { }),
  loadUsers: vi.fn(async () => { }),
  loadFilterableDictionaries: vi.fn(async () => { }),
  loadEnumItemsFor: vi.fn(async () => { }),
  searchEnumItemsFor: vi.fn(async () => { }),
  enumItemsFor: vi.fn(() => [
    {
      id: 'item-1',
      dictionary_version_id: 'ver-1',
      value_code: 'high',
      value_name: 'High',
      sort_order: 1,
      is_active: true,
    },
    {
      id: 'item-2',
      dictionary_version_id: 'ver-1',
      value_code: 'low',
      value_name: 'Low',
      sort_order: 2,
      is_active: true,
    },
  ]),
  activeFieldsFor: vi.fn(() => [{ id: 'fld-assignee', field_role: 'assignee', deleted_at: null }]),
})

vi.mock('@/stores/tasks', () => ({
  useTasksStore: () => tasksStoreMock,
}))

describe('TaskTrackerFilters', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    tasksStoreMock.activeFieldsFor.mockReset()
    tasksStoreMock.activeFieldsFor.mockReturnValue([{ id: 'fld-assignee', field_role: 'assignee', deleted_at: null }])
    tasksStoreMock.loadFilterableDictionaries.mockClear()
    tasksStoreMock.loadEnumItemsFor.mockClear()
    tasksStoreMock.searchEnumItemsFor.mockClear()
    tasksStoreMock.enumItemsFor.mockClear()
    filtersMock.searchInput.value = ''
    filtersMock.filtersVisible.value = false
    filtersMock.selectedStatusIds.value = []
    filtersMock.selectedTemplateId.value = null
    filtersMock.selectedAssigneeIds.value = []
    filtersMock.selectedDictionaryEnumCodes.value = {}
    filtersMock.createdFrom.value = ''
    filtersMock.createdTo.value = ''
    filtersMock.showSubtasks.value = false
  })

  function showSubtasksCheckbox(wrapper: ReturnType<typeof mount>) {
    const toggleLabel = wrapper.findAll('label').find(label => label.text().includes('Show subtasks'))
    expect(toggleLabel).toBeTruthy()
    return toggleLabel!.get('input[type="checkbox"]')
  }

  it('emits normalized filter payload for search + status + template + assignee + subtasks', async () => {
    vi.useFakeTimers()
    const wrapper = mount(TaskTrackerFilters, {
      props: {
        templateFilter: null,
        total: 1,
        showCreatedDateFilter: true,
      },
      global: {
        stubs: {
          UserAvatar: { template: '<div />' },
        },
      },
    })
    await flushPromises()

    await wrapper.get('input[placeholder="Search by ID, title, description…"]').setValue('  bug  ')
    await wrapper.get('input[placeholder="Search by ID, title, description…"]').trigger('input')
    vi.advanceTimersByTime(300)
    await flushPromises()

    await wrapper.get('button.toolbar-btn').trigger('click')

    const statusChip = wrapper.findAll('button.filter-chip').find(btn => btn.text().includes('Status'))
    expect(statusChip).toBeTruthy()
    await statusChip!.trigger('click')
    await wrapper.get('input[type="checkbox"][value="st-1"]').setValue(true)

    const templateChip = wrapper.findAll('button.filter-chip').find(btn => btn.text().includes('Template'))
    expect(templateChip).toBeTruthy()
    await templateChip!.trigger('click')
    await wrapper.findAll('button.dropdown-item').find(btn => btn.text().includes('BUG'))!.trigger('click')

    const assigneeChip = wrapper.findAll('button.filter-chip').find(btn => btn.text().includes('Assignee'))
    expect(assigneeChip).toBeTruthy()
    await assigneeChip!.trigger('click')
    await wrapper.get('input[type="checkbox"][value="u-1"]').setValue(true)

    const dictionaryChip = wrapper.findAll('button.filter-chip').find(btn => btn.text().includes('Priority'))
    expect(dictionaryChip).toBeTruthy()
    await dictionaryChip!.trigger('click')
    await wrapper.findAll('.dropdown-menu--dictionary input[type="checkbox"]')[0].setValue(true)
    await wrapper.findAll('.dropdown-menu--dictionary input[type="checkbox"]')[1].setValue(true)
    await wrapper.get('input[type="date"][aria-label="Created from"]').setValue('2026-05-01')
    await wrapper.get('input[type="date"][aria-label="Created to"]').setValue('2026-05-03')
    await showSubtasksCheckbox(wrapper).setValue(true)

    const emitted = wrapper.emitted('filtersChange')
    expect(emitted).toBeTruthy()
    const latest = emitted![emitted!.length - 1][0] as any
    expect(latest).toEqual({
      search: 'bug',
      status_ids: ['st-1'],
      prefixes: ['BUG'],
      include_subtasks: true,
      created_from: '2026-05-01',
      created_to: '2026-05-03',
      field_filters: [{ field_definition_id: 'fld-assignee', user_ids: ['u-1'] }],
      dictionary_filters: [{ dictionary_id: 'dict-1', enum_codes: ['high', 'low'] }],
    })
  })

  it('reacts to templateFilter prop changes', async () => {
    const wrapper = mount(TaskTrackerFilters, {
      props: {
        templateFilter: null,
        total: 1,
      },
      global: {
        stubs: {
          UserAvatar: { template: '<div />' },
        },
      },
    })
    await flushPromises()

    await wrapper.setProps({ templateFilter: 'tpl-1' })
    await flushPromises()

    const emitted = wrapper.emitted('filtersChange')
    expect(emitted).toBeTruthy()
    const latest = emitted![emitted!.length - 1][0] as any
    expect(latest.prefixes).toEqual(['BUG'])
  })

  it('uses a taller shared dropdown and single-scroll assignee layout', async () => {
    const wrapper = mount(TaskTrackerFilters, {
      props: {
        templateFilter: null,
        total: 1,
      },
      global: {
        stubs: {
          UserAvatar: { template: '<div />' },
        },
      },
    })
    await flushPromises()

    await wrapper.get('button.toolbar-btn').trigger('click')

    const statusChip = wrapper.findAll('button.filter-chip').find(btn => btn.text().includes('Status'))
    expect(statusChip).toBeTruthy()
    await statusChip!.trigger('click')

    const statusDropdown = wrapper.get('.dropdown-menu')
    expect(statusDropdown.classes()).toContain('dropdown-menu--tall')

    const assigneeChip = wrapper.findAll('button.filter-chip').find(btn => btn.text().includes('Assignee'))
    expect(assigneeChip).toBeTruthy()
    await assigneeChip!.trigger('click')

    const assigneeDropdown = wrapper.get('.dropdown-menu--assignee')
    expect(assigneeDropdown.classes()).toContain('dropdown-menu--tall')
    expect(wrapper.find('.assignee-dropdown-list').exists()).toBe(true)

    const dictionaryChip = wrapper.findAll('button.filter-chip').find(btn => btn.text().includes('Priority'))
    expect(dictionaryChip).toBeTruthy()
    await dictionaryChip!.trigger('click')
    const dictionaryDropdown = wrapper.get('.dropdown-menu--dictionary')
    expect(dictionaryDropdown.classes()).toContain('dropdown-menu--tall')
    expect(wrapper.find('.dictionary-dropdown-list').exists()).toBe(true)
  })

  it('keeps status and assignee controls clickable after dictionary dropdown state changes', async () => {
    const wrapper = mount(TaskTrackerFilters, {
      props: {
        templateFilter: null,
        total: 1,
      },
      global: {
        stubs: {
          UserAvatar: { template: '<div />' },
        },
      },
    })
    await flushPromises()

    await wrapper.get('button.toolbar-btn').trigger('click')

    const dictionaryChip = wrapper.findAll('button.filter-chip').find(btn => btn.text().includes('Priority'))
    expect(dictionaryChip).toBeTruthy()
    await dictionaryChip!.trigger('click')
    expect(wrapper.find('.dropdown-menu--dictionary').exists()).toBe(true)

    const statusChip = wrapper.findAll('button.filter-chip').find(btn => btn.text().includes('Status'))
    expect(statusChip).toBeTruthy()
    await statusChip!.trigger('click')
    expect(wrapper.findAll('.dropdown-menu').some(menu => menu.text().includes('Todo'))).toBe(true)

    const assigneeChip = wrapper.findAll('button.filter-chip').find(btn => btn.text().includes('Assignee'))
    expect(assigneeChip).toBeTruthy()
    await assigneeChip!.trigger('click')
    expect(wrapper.find('.dropdown-menu--assignee').exists()).toBe(true)
  })

  it('counts and clears the show subtasks toggle as an active filter', async () => {
    const wrapper = mount(TaskTrackerFilters, {
      props: {
        templateFilter: null,
        total: 1,
      },
      global: {
        stubs: {
          UserAvatar: { template: '<div />' },
        },
      },
    })
    await flushPromises()

    await wrapper.get('button.toolbar-btn').trigger('click')
    await showSubtasksCheckbox(wrapper).setValue(true)

    expect(wrapper.get('button.toolbar-btn').text()).toContain('1')

    const clearButton = wrapper.findAll('button').find(button => button.text() === 'Clear all')
    expect(clearButton).toBeTruthy()
    await clearButton!.trigger('click')

    const emitted = wrapper.emitted('filtersChange')
    expect(emitted).toBeTruthy()
    const latest = emitted![emitted!.length - 1][0] as any
    expect(latest.include_subtasks).toBe(false)
    expect(wrapper.get('button.toolbar-btn').text()).not.toContain('1')
  })

  it('counts, emits, clears, and hides created date filters', async () => {
    const wrapper = mount(TaskTrackerFilters, {
      props: {
        templateFilter: null,
        total: 1,
        showCreatedDateFilter: true,
      },
      global: {
        stubs: {
          UserAvatar: { template: '<div />' },
        },
      },
    })
    await flushPromises()

    await wrapper.get('button.toolbar-btn').trigger('click')
    await wrapper.get('input[type="date"][aria-label="Created from"]').setValue('2026-05-01')
    await wrapper.get('input[type="date"][aria-label="Created to"]').setValue('2026-05-03')

    expect(wrapper.get('button.toolbar-btn').text()).toContain('1')

    let emitted = wrapper.emitted('filtersChange')
    expect(emitted).toBeTruthy()
    let latest = emitted![emitted!.length - 1][0] as any
    expect(latest.created_from).toBe('2026-05-01')
    expect(latest.created_to).toBe('2026-05-03')

    const clearButton = wrapper.findAll('button').find(button => button.text() === 'Clear all')
    expect(clearButton).toBeTruthy()
    await clearButton!.trigger('click')

    emitted = wrapper.emitted('filtersChange')
    latest = emitted![emitted!.length - 1][0] as any
    expect(latest.created_from).toBeUndefined()
    expect(latest.created_to).toBeUndefined()
    expect(wrapper.get('button.toolbar-btn').text()).not.toContain('1')

    await wrapper.setProps({ showCreatedDateFilter: false })
    await flushPromises()
    expect(wrapper.find('input[type="date"]').exists()).toBe(false)
  })

  it('restores filter state from composable when remounted (view switch)', async () => {
    filtersMock.selectedStatusIds.value = ['st-1']
    filtersMock.selectedDictionaryEnumCodes.value = { 'dict-1': ['high'] }
    filtersMock.showSubtasks.value = true
    filtersMock.filtersVisible.value = true

    const wrapper = mount(TaskTrackerFilters, {
      props: {
        templateFilter: null,
        total: 5,
      },
      global: {
        stubs: {
          UserAvatar: { template: '<div />' },
        },
      },
    })
    await flushPromises()

    expect(wrapper.get('button.toolbar-btn').text()).toContain('3')
    expect((showSubtasksCheckbox(wrapper).element as HTMLInputElement).checked).toBe(true)
    const statusChip = wrapper.findAll('button.filter-chip').find(btn => btn.text().includes('Status'))
    expect(statusChip!.classes()).toContain('active')
    const dictionaryChip = wrapper.findAll('button.filter-chip').find(btn => btn.text().includes('Priority'))
    expect(dictionaryChip!.classes()).toContain('active')
  })
})
