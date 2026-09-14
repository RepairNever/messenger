import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { activeEmojiPickerId, createEmojiPickerInstanceId } from '@/stores/emojiPicker'

interface EmojiSelection {
  native?: string
  colons?: string
  id?: string
}

interface UseComposerEmojiPickerOptions {
  onSelect: (emoji: string) => void
}

const EMOJI_PICKER_WIDTH = 340
const EMOJI_PICKER_HEIGHT = 380
const EMOJI_PICKER_GAP = 8
const EMOJI_PICKER_EDGE_PADDING = 8

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

export function useComposerEmojiPicker(options: UseComposerEmojiPickerOptions) {
  const showEmojiPicker = ref(false)
  const pickerRoot = ref<HTMLElement | null>(null)
  const pickerToggleButton = ref<HTMLElement | null>(null)
  const pickerComponent = shallowRef<any>(null)
  const emojiIndex = shallowRef<any>(null)
  const emojiPickerLoading = ref(false)
  const emojiPickerStyle = ref<Record<string, string>>({
    position: 'fixed',
    top: '8px',
    left: '8px',
    width: '340px',
  })
  const instanceId = createEmojiPickerInstanceId()

  async function ensureEmojiPickerLoaded() {
    if (pickerComponent.value && emojiIndex.value) return
    if (emojiPickerLoading.value) return
    emojiPickerLoading.value = true
    try {
      const [pickerModule, emojiDataModule] = await Promise.all([
        import('emoji-mart-vue-fast/src'),
        import('emoji-mart-vue-fast/data/all.json'),
      ])
      const data = (emojiDataModule as any).default ?? emojiDataModule
      pickerComponent.value = pickerModule.Picker
      emojiIndex.value = new pickerModule.EmojiIndex(data)
    } catch (error) {
      console.error('[composer] emoji picker load failed', error)
      closeEmojiPicker()
    } finally {
      emojiPickerLoading.value = false
    }
  }

  function updateEmojiPickerPosition() {
    const trigger = pickerToggleButton.value
    if (!trigger) return

    const rect = trigger.getBoundingClientRect()
    const viewportHeight = window.innerHeight
    const viewportWidth = window.innerWidth
    if (viewportHeight <= 0 || viewportWidth <= 0) return

    const availablePickerHeight = Math.max(
      0,
      Math.min(EMOJI_PICKER_HEIGHT, viewportHeight - EMOJI_PICKER_EDGE_PADDING * 2),
    )
    const availablePickerWidth = Math.max(
      0,
      Math.min(EMOJI_PICKER_WIDTH, viewportWidth - EMOJI_PICKER_EDGE_PADDING * 2),
    )
    if (availablePickerHeight <= 0 || availablePickerWidth <= 0) return

    const spaceBelow = viewportHeight - rect.bottom - EMOJI_PICKER_EDGE_PADDING
    const spaceAbove = rect.top - EMOJI_PICKER_EDGE_PADDING
    const canOpenDown = spaceBelow >= availablePickerHeight + EMOJI_PICKER_GAP
    const canOpenUp = spaceAbove >= availablePickerHeight + EMOJI_PICKER_GAP
    const openUp = canOpenDown ? false : (canOpenUp || spaceAbove > spaceBelow)
    const rawTop = openUp
      ? rect.top - availablePickerHeight - EMOJI_PICKER_GAP
      : rect.bottom + EMOJI_PICKER_GAP

    const topMax = viewportHeight - availablePickerHeight - EMOJI_PICKER_EDGE_PADDING
    const leftMax = viewportWidth - availablePickerWidth - EMOJI_PICKER_EDGE_PADDING
    const top = clamp(rawTop, EMOJI_PICKER_EDGE_PADDING, topMax)
    const left = clamp(rect.left, EMOJI_PICKER_EDGE_PADDING, leftMax)

    emojiPickerStyle.value = {
      ...emojiPickerStyle.value,
      top: `${Math.round(top)}px`,
      left: `${Math.round(left)}px`,
      overflow: 'hidden',
    }
  }

  function closeEmojiPicker() {
    showEmojiPicker.value = false
    if (activeEmojiPickerId.value === instanceId) {
      activeEmojiPickerId.value = null
    }
  }

  function toggleEmojiPicker() {
    if (showEmojiPicker.value) {
      closeEmojiPicker()
      return
    }
    activeEmojiPickerId.value = instanceId
    showEmojiPicker.value = true
    void ensureEmojiPickerLoaded()
    void nextTick(updateEmojiPickerPosition)
  }

  function handleDocumentClick(evt: MouseEvent) {
    if (!showEmojiPicker.value) return
    const target = evt.target as Node
    if (pickerToggleButton.value?.contains(target)) return
    if (pickerRoot.value?.contains(target)) return
    closeEmojiPicker()
  }

  function handleEscape(evt: KeyboardEvent) {
    if (evt.key !== 'Escape') return
    closeEmojiPicker()
  }

  function onSelectEmoji(emoji: EmojiSelection) {
    const value = emoji.native ?? emoji.colons ?? emoji.id
    if (!value) return
    options.onSelect(value)
    closeEmojiPicker()
  }

  watch(activeEmojiPickerId, value => {
    if (value !== instanceId && showEmojiPicker.value) {
      showEmojiPicker.value = false
    }
  })

  watch(showEmojiPicker, visible => {
    if (visible) {
      document.addEventListener('click', handleDocumentClick)
      document.addEventListener('keydown', handleEscape)
      window.addEventListener('resize', updateEmojiPickerPosition)
      window.addEventListener('scroll', updateEmojiPickerPosition, true)
      void nextTick(updateEmojiPickerPosition)
      return
    }
    document.removeEventListener('click', handleDocumentClick)
    document.removeEventListener('keydown', handleEscape)
    window.removeEventListener('resize', updateEmojiPickerPosition)
    window.removeEventListener('scroll', updateEmojiPickerPosition, true)
  })

  onBeforeUnmount(() => {
    document.removeEventListener('click', handleDocumentClick)
    document.removeEventListener('keydown', handleEscape)
    window.removeEventListener('resize', updateEmojiPickerPosition)
    window.removeEventListener('scroll', updateEmojiPickerPosition, true)
    if (activeEmojiPickerId.value === instanceId) {
      activeEmojiPickerId.value = null
    }
  })

  return {
    showEmojiPicker,
    pickerRoot,
    pickerToggleButton,
    pickerComponent,
    emojiIndex,
    emojiPickerStyle,
    toggleEmojiPicker,
    closeEmojiPicker,
    onSelectEmoji,
  }
}
