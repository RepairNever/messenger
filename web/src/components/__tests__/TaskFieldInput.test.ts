import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TaskFieldInput from '@/components/tasks/TaskFieldInput.vue'

const baseField = {
  id: 'field-1',
  template_id: 'template-1',
  code: 'version',
  name: 'Version',
  required: false,
  sort_order: 1,
  enum_dictionary_id: 'dict-1',
  field_role: null,
  deleted_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const enumItems = [
  {
    id: 'item-1',
    dictionary_version_id: 'ver-1',
    value_code: 'v1',
    value_name: 'Version 1',
    sort_order: 1,
    is_active: true,
  },
  {
    id: 'item-2',
    dictionary_version_id: 'ver-1',
    value_code: 'v2',
    value_name: 'Version 2',
    sort_order: 2,
    is_active: true,
  },
]

const users = [
  {
    id: 'user-1',
    display_name: 'Alice',
    email: 'alice@example.com',
  },
  {
    id: 'user-2',
    display_name: '',
    email: 'bob@example.com',
  },
]

const clipboardWriteText = vi.fn()

describe('TaskFieldInput', () => {
  beforeEach(() => {
    clipboardWriteText.mockReset()
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: clipboardWriteText,
      },
      configurable: true,
    })
  })

  it('renders searchable combobox for enum fields instead of a native select', async () => {
    const wrapper = mount(TaskFieldInput, {
      props: {
        field: { ...baseField, type: 'enum' },
        value: null,
        mode: 'edit',
        enumItems,
        enumDictionary: {
          id: 'dict-1',
          code: 'versions',
          name: 'Versions',
          is_public: false,
          participates_in_filtration: false,
          current_version: 1,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      },
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })

    expect(wrapper.find('select').exists()).toBe(false)

    await wrapper.find('button.multiselect-trigger').trigger('click')
    await flushPromises()

    const search = wrapper.find('input[placeholder="Search..."]')
    expect(search.exists()).toBe(true)

    await search.setValue('Version 2')
    await flushPromises()
    expect(wrapper.emitted('search:enum-items')).toBeTruthy()

    await wrapper.findAll('li')[1].trigger('click')

    expect(wrapper.emitted('update:value')).toEqual([['v2']])
  })

  it('renders searchable combobox for multi_enum fields and emits create for public dictionaries', async () => {
    const wrapper = mount(TaskFieldInput, {
      props: {
        field: { ...baseField, type: 'multi_enum' },
        value: [],
        mode: 'edit',
        enumItems,
        enumDictionary: {
          id: 'dict-1',
          code: 'versions',
          name: 'Versions',
          is_public: true,
          participates_in_filtration: false,
          current_version: 1,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      },
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })

    await wrapper.find('button.multiselect-trigger').trigger('click')
    await flushPromises()

    const search = wrapper.find('input[placeholder="Search..."]')
    await search.setValue('Version 1')
    await flushPromises()
    expect(wrapper.emitted('search:enum-items')).toBeTruthy()
    await wrapper.findAll('li')[0].trigger('click')

    expect(wrapper.emitted('update:value')).toEqual([[['v1']]])

    await search.setValue('Version 3')
    await flushPromises()

    const createOption = wrapper.findAll('li').find(item => item.text().includes('Add "Version 3"'))
    expect(createOption).toBeTruthy()
    await createOption!.trigger('click')

    expect(wrapper.emitted('create:enum-item')).toEqual([['Version 3']])
  })

  it('does not show inline create for private dictionaries', async () => {
    const wrapper = mount(TaskFieldInput, {
      props: {
        field: { ...baseField, type: 'enum' },
        value: null,
        mode: 'edit',
        enumItems,
        enumDictionary: {
          id: 'dict-1',
          code: 'versions',
          name: 'Versions',
          is_public: false,
          participates_in_filtration: false,
          current_version: 1,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      },
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })

    await wrapper.find('button.multiselect-trigger').trigger('click')
    await flushPromises()

    const search = wrapper.find('input[placeholder="Search..."]')
    await search.setValue('Version 9')
    await flushPromises()

    expect(wrapper.text()).not.toContain('Add "Version 9"')
  })

  it('copies the selected enum label', async () => {
    const wrapper = mount(TaskFieldInput, {
      props: {
        field: { ...baseField, type: 'enum' },
        value: 'v2',
        mode: 'edit',
        enumItems,
      },
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })

    await wrapper.get('[data-testid="task-field-copy-selected"]').trigger('click')

    expect(clipboardWriteText).toHaveBeenCalledWith('Version 2')
  })

  it('renders the copy button in the label row above the dropdown', () => {
    const wrapper = mount(TaskFieldInput, {
      props: {
        field: { ...baseField, type: 'enum' },
        value: 'v2',
        mode: 'edit',
        enumItems,
      },
      slots: {
        label: '<span data-testid="field-label">Version</span>',
      },
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })

    const labelRow = wrapper.get('.field-dropdown-label-row')
    expect(labelRow.find('[data-testid="field-label"]').text()).toBe('Version')
    expect(labelRow.find('[data-testid="task-field-copy-selected"]').exists()).toBe(true)
    const stackChildren = wrapper.get('.field-dropdown-stack').element.children
    expect(stackChildren[0].classList.contains('field-dropdown-label-row')).toBe(true)
    expect(stackChildren[1].querySelector('.multiselect-trigger')).not.toBeNull()
  })

  it('copies selected multi-enum labels as a comma-separated list', async () => {
    const wrapper = mount(TaskFieldInput, {
      props: {
        field: { ...baseField, type: 'multi_enum' },
        value: ['v1', 'v2'],
        mode: 'edit',
        enumItems,
      },
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })

    await wrapper.get('[data-testid="task-field-copy-selected"]').trigger('click')

    expect(clipboardWriteText).toHaveBeenCalledWith('Version 1, Version 2')
  })

  it('copies selected user labels with email fallback', async () => {
    const wrapper = mount(TaskFieldInput, {
      props: {
        field: { ...baseField, enum_dictionary_id: null, type: 'users' },
        value: ['user-1', 'user-2'],
        mode: 'edit',
        users,
      },
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })

    await wrapper.get('[data-testid="task-field-copy-selected"]').trigger('click')

    expect(clipboardWriteText).toHaveBeenCalledWith('Alice, bob@example.com')
  })

  it('disables copying when no dropdown values are selected', () => {
    const wrapper = mount(TaskFieldInput, {
      props: {
        field: { ...baseField, type: 'multi_enum' },
        value: [],
        mode: 'edit',
        enumItems,
      },
      global: {
        stubs: {
          UserAvatar: true,
        },
      },
    })

    const copyButton = wrapper.get<HTMLButtonElement>('[data-testid="task-field-copy-selected"]')
    expect(copyButton.element.disabled).toBe(true)
  })
})
