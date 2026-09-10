// @vitest-environment node
import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join as joinStylePath } from 'node:path'
import { overflowMenuDiagnostics } from '@valley/plugin-tools'

it('gives openLayoutMenu overflow actions semantic icons', () => {
  expect(overflowMenuDiagnostics(readFileSync(joinStylePath(process.cwd(), 'src/ui.tsx'), 'utf8'), ['openLayoutMenu'])).toEqual([])
})
