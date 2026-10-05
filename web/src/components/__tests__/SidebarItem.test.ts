import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SidebarItem from '@/components/SidebarItem.vue'

describe('SidebarItem', () => {
  it('renders unread count badge when unread is greater than zero', () => {
    const wrapper = mount(SidebarItem, {
      props: { unread: 3 },
      slots: { default: 'general' },
    })
    expect(wrapper.text()).toContain('3')
  })

  it('hides row actions until hover or focus, and keeps them pinned while requested', () => {
    const wrapper = mount(SidebarItem, {
      props: { unread: 0 },
      slots: { default: 'general', actions: '<button data-testid="item-kebab">kebab</button>' },
    })

    const pill = wrapper.get('[data-testid="sidebar-item-actions"]')
    expect(pill.classes()).toEqual(expect.arrayContaining([
      'hidden',
      'group-hover:flex',
      'group-focus-within:flex',
    ]))
    expect(pill.find('[data-testid="item-kebab"]').exists()).toBe(true)

    const pinned = mount(SidebarItem, {
      props: { unread: 0, actionsPinned: true },
      slots: { default: 'general', actions: '<button>kebab</button>' },
    })
    const pinnedPill = pinned.get('[data-testid="sidebar-item-actions"]')
    expect(pinnedPill.classes()).toContain('flex')
    expect(pinnedPill.classes()).not.toContain('hidden')
  })

  it('does not render the actions pill without an actions slot', () => {
    const wrapper = mount(SidebarItem, {
      props: { unread: 0 },
      slots: { default: 'general' },
    })
    expect(wrapper.find('[data-testid="sidebar-item-actions"]').exists()).toBe(false)
  })
})
