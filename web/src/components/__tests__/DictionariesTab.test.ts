import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DictionariesTab from '@/components/admin/DictionariesTab.vue'

const apiMocks = vi.hoisted(() => ({
  tasksListDictionaries: vi.fn(),
  tasksCreateDictionary: vi.fn(),
  tasksUpdateDictionary: vi.fn(),
  tasksListDictionaryVersions: vi.fn(),
  tasksCreateDictionaryVersion: vi.fn(),
  tasksGetDictionaryVersionItems: vi.fn(),
}))

vi.mock('@/services/http/tasksApi', () => ({
  tasksListDictionaries: apiMocks.tasksListDictionaries,
  tasksCreateDictionary: apiMocks.tasksCreateDictionary,
  tasksUpdateDictionary: apiMocks.tasksUpdateDictionary,
  tasksListDictionaryVersions: apiMocks.tasksListDictionaryVersions,
  tasksCreateDictionaryVersion: apiMocks.tasksCreateDictionaryVersion,
  tasksGetDictionaryVersionItems: apiMocks.tasksGetDictionaryVersionItems,
}))

describe('DictionariesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.tasksListDictionaries.mockResolvedValue([
      {
        id: 'dict-1',
        code: 'priority',
        name: 'Priority',
        is_public: false,
        participates_in_filtration: false,
        current_version: 2,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
      },
    ])
    apiMocks.tasksListDictionaryVersions.mockResolvedValue([
      {
        id: 'ver-2',
        dictionary_id: 'dict-1',
        version: 2,
        created_at: '2026-01-02T00:00:00Z',
        created_by: 'user-1',
      },
      {
        id: 'ver-1',
        dictionary_id: 'dict-1',
        version: 1,
        created_at: '2026-01-01T00:00:00Z',
        created_by: 'user-1',
      },
    ])
    apiMocks.tasksGetDictionaryVersionItems.mockResolvedValue([
      {
        id: 'item-1',
        dictionary_version_id: 'ver-2',
        value_code: 'high',
        value_name: 'High',
        sort_order: 1,
        is_active: true,
      },
      {
        id: 'item-2',
        dictionary_version_id: 'ver-2',
        value_code: 'medium',
        value_name: 'Medium',
        sort_order: 2,
        is_active: true,
      },
    ])
    apiMocks.tasksCreateDictionaryVersion.mockResolvedValue({
      id: 'ver-2',
      dictionary_id: 'dict-1',
      version: 2,
      created_at: '2026-01-02T00:00:00Z',
      created_by: 'user-1',
    })
    apiMocks.tasksUpdateDictionary.mockResolvedValue({
      id: 'dict-1',
      code: 'priority',
      name: 'Priority',
      is_public: true,
      participates_in_filtration: false,
      current_version: 2,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-03T00:00:00Z',
    })
  })

  it('uses neutral item-editing copy', async () => {
    const wrapper = mount(DictionariesTab, {
      global: {
        stubs: {
          Teleport: true,
        },
      },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Edit Items')
    expect(wrapper.text()).not.toContain('New Version')
    expect(wrapper.text()).not.toContain('Save Version')
  })

  it('renders the item editor dialog at full width', async () => {
    const wrapper = mount(DictionariesTab, {
      global: {
        stubs: {
          Teleport: true,
        },
      },
    })
    await flushPromises()

    const versionsButton = wrapper.findAll('button').find(button => button.text() === 'Versions')
    expect(versionsButton).toBeTruthy()
    await versionsButton!.trigger('click')
    await flushPromises()

    const editButton = wrapper.findAll('button').find(button => button.text() === 'Edit Items')
    expect(editButton).toBeTruthy()
    await editButton!.trigger('click')
    await flushPromises()

    const dialog = wrapper.get('div.fixed.inset-0 > div')
    expect(dialog.classes()).toContain('w-full')
    expect(dialog.classes()).toContain('max-w-none')
  })

  it('renders the view items panel with full-width rows', async () => {
    const wrapper = mount(DictionariesTab, {
      global: {
        stubs: {
          Teleport: true,
        },
      },
    })
    await flushPromises()

    const versionsButton = wrapper.findAll('button').find(button => button.text() === 'Versions')
    expect(versionsButton).toBeTruthy()
    await versionsButton!.trigger('click')
    await flushPromises()

    const viewItemsButton = wrapper.findAll('button').find(button => button.text() === 'View Items')
    expect(viewItemsButton).toBeTruthy()
    await viewItemsButton!.trigger('click')
    await flushPromises()

    const itemsPanel = wrapper.find('div.border-t.border-chat-border.px-4.py-3 > div.w-full.overflow-x-auto')
    expect(itemsPanel.exists()).toBe(true)
    expect(itemsPanel.text()).toContain('High')
  })

  it('submits current items and refreshes dictionaries and versions after save', async () => {
    const wrapper = mount(DictionariesTab, {
      global: {
        stubs: {
          Teleport: true,
        },
      },
    })
    await flushPromises()

    const versionsButton = wrapper.findAll('button').find(button => button.text() === 'Versions')
    expect(versionsButton).toBeTruthy()
    await versionsButton!.trigger('click')
    await flushPromises()

    const editButton = wrapper.findAll('button').find(button => button.text() === 'Edit Items')
    expect(editButton).toBeTruthy()
    await editButton!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Save Changes')
    expect(wrapper.text()).not.toContain('Order')

    const row0 = wrapper.get('[data-testid="dictionary-item-row-0"]')
    const row1 = wrapper.get('[data-testid="dictionary-item-row-1"]')
    await row1.trigger('dragstart')
    await row0.trigger('dragover')
    await row0.trigger('drop')
    await flushPromises()

    const saveButton = wrapper.findAll('button').find(button => button.text() === 'Save Changes')
    expect(saveButton).toBeTruthy()
    await saveButton!.trigger('click')
    await flushPromises()

    expect(apiMocks.tasksCreateDictionaryVersion).toHaveBeenCalledWith('dict-1', [
      { value_code: 'medium', value_name: 'Medium', sort_order: 1, is_active: true },
      { value_code: 'high', value_name: 'High', sort_order: 2, is_active: true },
    ])
    expect(apiMocks.tasksListDictionaries).toHaveBeenCalledTimes(2)
    expect(apiMocks.tasksListDictionaryVersions).toHaveBeenCalledTimes(3)
  })

  it('submits is_public on create and allows toggling visibility', async () => {
    apiMocks.tasksCreateDictionary.mockResolvedValue({
      id: 'dict-2',
      code: 'versions',
      name: 'Versions',
      is_public: true,
      participates_in_filtration: true,
      current_version: 1,
      created_at: '2026-01-03T00:00:00Z',
      updated_at: '2026-01-03T00:00:00Z',
    })

    const wrapper = mount(DictionariesTab, {
      global: {
        stubs: {
          Teleport: true,
        },
      },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Private')

    const createButton = wrapper.findAll('button').find(button => button.text() === 'Create Dictionary')
    expect(createButton).toBeTruthy()
    await createButton!.trigger('click')
    await flushPromises()

    const codeInput = wrapper.find('input[placeholder="priority"]')
    const nameInput = wrapper.find('input[placeholder="Priority"]')
    const publicCheckbox = wrapper.find('input[type="checkbox"]')
    const filtrationCheckbox = wrapper.findAll('input[type="checkbox"]')[1]
    await codeInput.setValue('versions')
    await nameInput.setValue('Versions')
    await publicCheckbox.setValue(true)
    await filtrationCheckbox.setValue(true)

    const confirmCreateButton = wrapper.findAll('button').find(button => button.text() === 'Create')
    expect(confirmCreateButton).toBeTruthy()
    await confirmCreateButton!.trigger('click')
    await flushPromises()

    expect(apiMocks.tasksCreateDictionary).toHaveBeenCalledWith({
      code: 'versions',
      name: 'Versions',
      is_public: true,
      participates_in_filtration: true,
    })

    const toggleButton = wrapper.findAll('button').find(button => button.text() === 'Private')
    expect(toggleButton).toBeTruthy()
    await toggleButton!.trigger('click')
    await flushPromises()

    expect(apiMocks.tasksUpdateDictionary).toHaveBeenCalledWith('dict-1', {
      is_public: true,
      participates_in_filtration: false,
    })
    expect(wrapper.text()).toContain('Public')
  })

  it('toggles dictionary filtration', async () => {
    apiMocks.tasksUpdateDictionary.mockResolvedValue({
      id: 'dict-1',
      code: 'priority',
      name: 'Priority',
      is_public: false,
      participates_in_filtration: true,
      current_version: 2,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-03T00:00:00Z',
    })

    const wrapper = mount(DictionariesTab, {
      global: {
        stubs: {
          Teleport: true,
        },
      },
    })
    await flushPromises()

    const toggleButton = wrapper.findAll('button').find(button => button.text() === 'Disabled')
    expect(toggleButton).toBeTruthy()
    await toggleButton!.trigger('click')
    await flushPromises()

    expect(apiMocks.tasksUpdateDictionary).toHaveBeenCalledWith('dict-1', {
      is_public: false,
      participates_in_filtration: true,
    })
    expect(wrapper.text()).toContain('Enabled')
  })
})
