import { describe, expect, test } from 'vitest'

// @ts-expect-error -- untyped virtual file provided by custom plugin
import virtualFile1 from 'virtual:vitest-custom-virtual-file-1'

import { implicitElse } from '../src/implicitElse'
import { useImportEnv } from '../src/importEnv'
import { second } from '../src/function-count'
import MultiSuite from '../src/multi-suite'
import { DecoratorsTester } from '../src/decorators'

// @ts-expect-error -- untyped virtual file provided by custom plugin
import virtualFile2 from '\0vitest-custom-virtual-file-2'

// Browser mode crashes with dynamic files. Enable this when browser mode works.
// To keep istanbul report consistent between browser and node, skip dynamic tests when istanbul is used.
const provider = globalThis.process?.env.COVERAGE_PROVIDER
const skipDynamicFiles = '__vitest_browser__' in globalThis || provider === 'istanbul' || !provider

const { pythagoras } = await (() => {
  if ('__vitest_browser__' in globalThis) {
    // TODO: remove workaround after vite 4.3.2
    // @ts-expect-error extension is not specified
    return import('../src/index')
  }
  const dynamicImport = '../src/index.mjs'
  return import(dynamicImport)
})()

test('Math.sqrt()', async () => {
  expect(pythagoras(3, 4)).toBe(5)
})

test('implicit else', () => {
  expect(implicitElse(true)).toBe(2)
})

test('import meta env', () => {
  expect(useImportEnv()).toBe(true)
})

test('cover function counts', () => {
  expect(second()).toBe(2)
})

describe('Multiple test suites', () => {
  describe('func1()', () => {
    test('func1', () => {
      const data = ['a', 'b']
      const val = MultiSuite.func1(data)
      expect(val).toEqual(data)
    })
  })
  describe('func2()', () => {
    test('func2', () => {
      const data = ['c', 'd']
      const val = MultiSuite.func2(data)
      expect(val).toEqual(data)
    })
  })
})

test.skipIf(skipDynamicFiles)('run dynamic ESM file', async () => {
  const { runDynamicFileESM } = await import('../src/dynamic-files')
  await runDynamicFileESM()
})

test.skipIf(skipDynamicFiles)('run dynamic CJS file', async () => {
  const { runDynamicFileCJS } = await import('../src/dynamic-files')
  await runDynamicFileCJS()
})

test('virtual file imports', () => {
  expect(virtualFile1).toBe('This file should be excluded from coverage report #1')
  expect(virtualFile2).toBe('This file should be excluded from coverage report #2')
})

test('decorators', () => {
  new DecoratorsTester().method('cover line')
})

// Istanbul fails to follow source maps on windows
test.runIf(provider === 'v8' || provider === 'custom')('pre-transpiled code with source maps to original', async () => {
  const transpiled = await import('../src/transpiled.js')

  transpiled.hello()
})

test.runIf(provider === 'v8' || provider === 'custom')('file loaded outside Vite, #5639', async () => {
  const { Module: { createRequire } } = await import('node:module')

  const noop = createRequire(import.meta.url)('../src/load-outside-vite.cjs')
  expect(noop).toBeTypeOf('function')
})
