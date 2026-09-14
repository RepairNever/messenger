// @ts-expect-error The app does not ship Node types, but Vitest runs this file in Node.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cssThemeTokenNames } from '@/composables/useColorTheme'
import { getColorTheme } from '@/services/theme/themes'
import { hexToRgbTriplet } from '@/utils/color'

declare const process: { cwd: () => string }

function rootColorVariables(css: string): Record<string, string> {
  const root = css.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? ''
  return Object.fromEntries(
    [...root.matchAll(/--color-([\w-]+):\s*([^;]+);/g)]
      .map(([, name, value]) => [name, value.trim()]),
  )
}

describe('dark theme defaults', () => {
  it('keeps the pre-JavaScript root defaults synchronized with the dark preset', () => {
    const css = readFileSync(`${process.cwd()}/src/style.css`, 'utf8')
    const variables = rootColorVariables(css)
    const dark = getColorTheme('dark')

    for (const [tokenName, cssName] of Object.entries(cssThemeTokenNames)) {
      expect(variables[cssName], `--color-${cssName}`).toBe(
        hexToRgbTriplet(dark.tokens[tokenName as keyof typeof dark.tokens]),
      )
    }
  })
})
