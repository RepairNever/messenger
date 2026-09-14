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

})
