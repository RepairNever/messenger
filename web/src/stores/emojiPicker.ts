import { ref } from 'vue'

export const activeEmojiPickerId = ref<string | null>(null)

let nextEmojiPickerId = 0

export function createEmojiPickerInstanceId(): string {
  nextEmojiPickerId += 1
  return `emoji-picker-${nextEmojiPickerId}`
}
