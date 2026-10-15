import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import TaskTrackerShell from '@/components/tasks/TaskTrackerShell.vue'

vi.mock('@/components/ResizableSidebar.vue', () => ({
  default: {
    template: '<div data-testid="resizable-sidebar"><slot /></div>',
  },
}))

vi.mock('@/components/tasks/TaskTrackerSidebar.vue', () => ({
  default: {
    template: '<aside data-testid="task-tracker-sidebar" />',
  },
}))

vi.mock('@/components/tasks/TaskCard.vue', () => ({
  default: {
    template: '<section data-testid="task-card" />',
  },
}))

vi.mock('@/components/tasks/TaskKanbanView.vue', () => ({
  default: {
    template: '<section data-testid="task-kanban-view" />',
  },
}))

vi.mock('@/components/tasks/TaskListView.vue', () => ({
  default: {
    template: '<section data-testid="task-list-view"><input /></section>',
  },
}))

vi.mock('@/components/tasks/TaskCreateDialog.vue', () => ({
  default: {
    props: ['initialTemplateId'],
    template: '<div data-testid="task-create-dialog" :data-initial-template-id="initialTemplateId" />',
  },
}))

describe('TaskTrackerShell', () => {
  it('renders the sidebar when not collapsed', () => {
    const wrapper = mount(TaskTrackerShell, {
      props: {
        modelValue: null,
        sidebarCollapsed: false,
        currentView: 'tasks-list',
        viewMode: 'list',
      },
    })

    expect(wrapper.find('[data-testid="resizable-sidebar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="task-tracker-sidebar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="task-list-view"]').exists()).toBe(true)
  })

  it('hides the sidebar and keeps content visible when collapsed', () => {
    const wrapper = mount(TaskTrackerShell, {
      props: {
        modelValue: null,
        sidebarCollapsed: true,
        currentView: 'tasks-list',
        viewMode: 'kanban',
      },
    })

    expect(wrapper.find('[data-testid="resizable-sidebar"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="task-tracker-sidebar"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="task-kanban-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="task-create-dialog"]').exists()).toBe(true)
  })

  it('passes the selected template filter to the create dialog', () => {
    const wrapper = mount(TaskTrackerShell, {
      props: {
        modelValue: 'tpl-2',
        sidebarCollapsed: false,
        currentView: 'tasks-list',
        viewMode: 'list',
      },
    })

    expect(wrapper.get('[data-testid="task-create-dialog"]').attributes('data-initial-template-id')).toBe('tpl-2')
  })

  it('keeps the list DOM and local state while a task card is open', async () => {
    const wrapper = mount(TaskTrackerShell, {
      props: {
        modelValue: null,
        sidebarCollapsed: true,
        currentView: 'tasks-list',
        viewMode: 'list',
      },
    })
    const input = wrapper.get('[data-testid="task-list-view"] input')
    await input.setValue('remembered list state')

    await wrapper.setProps({ viewMode: 'card' })
    expect(wrapper.find('[data-testid="task-list-view"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="task-card"]').exists()).toBe(true)

    await wrapper.setProps({ viewMode: 'list' })
    expect(wrapper.get('[data-testid="task-list-view"] input').element).toBe(input.element)
    expect((input.element as HTMLInputElement).value).toBe('remembered list state')
    wrapper.unmount()
  })
})
