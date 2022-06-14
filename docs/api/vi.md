# Vi Object

Vitest provides utility functions to help you out through it's **vi** helper. You can `import { vi } from 'vitest'` or access it **globally** (when [globals configuration](/config/#globals) is **enabled**).

## vi.advanceTimersByTime

- **Type:** `(ms: number) => Vitest`

  Works just like `runAllTimers`, but will end after passed milliseconds. For example this will log `1, 2, 3` and will not throw:

  ```ts
  let i = 0
  setInterval(() => console.log(++i), 50)

  vi.advanceTimersByTime(150)
  ```

## vi.advanceTimersToNextTimer

- **Type:** `() => Vitest`

  Will call next available timer. Useful to make assertions between each timer call. You can chain call it to manage timers by yourself.

  ```ts
  let i = 0
  setInterval(() => console.log(++i), 50)

  vi.advanceTimersToNextTimer() // log 1
    .advanceTimersToNextTimer() // log 2
    .advanceTimersToNextTimer() // log 3
  ```

## vi.clearAllTimers

  Removes all timers that are scheduled to run. These timers will never run in the future.

## vi.dynamicImportSettled

  Wait for all imports to load. Useful, if you have a synchronous call that starts importing a module, that you cannot wait otherwise.

## vi.fn

- **Type:** `(fn: Function) => CallableMockInstance`

  Creates a spy on a function, though can be initiated without one. Every time a function is invoked, it stores its call arguments, returns and instances. Also, you can manipulate its behavior with [methods](#mockinstance-methods).
  If no function is given, mock will return `undefined`, when invoked.

  ```ts
  const getApples = vi.fn(() => 0)

  getApples()

  expect(getApples).toHaveBeenCalled()
  expect(getApples).toHaveReturnedWith(0)

  getApples.mockReturnValueOnce(5)

  const res = getApples()
  expect(res).toBe(5)
  expect(getApples).toHaveNthReturnedWith(2, 5)
  ```

## vi.getMockedSystemTime

- **Type**: `() => Date | null`

  Returns mocked current date that was set using `setSystemTime`. If date is not mocked, will return `null`.

## vi.getRealSystemTime

- **Type**: `() => number`

  When using `vi.useFakeTimers`, `Date.now` calls are mocked. If you need to get real time in milliseconds, you can call this function.

## vi.mock

- **Type**: `(path: string, factory?: () => unknown) => void`

  Makes all `imports` to passed module to be mocked. Inside a path you _can_ use configured Vite aliases.

  - If `factory` is defined, will return its result. Factory function can be asynchronous. You may call [`vi.importActual`](#vi-importactual) inside to get the original module. The call to `vi.mock` is hoisted to the top of the file, so you don't have access to variables declared in the global file scope!
  - If mocking a module with a default export, you'll need to provide a `default` key within the returned factory function object. This is an ES modules specific caveat, therefore `jest` documentation may differ as `jest` uses commonJS modules. *Example:*

  ```ts
  vi.mock('path', () => {
    return {
      default: { myDefaultKey: vi.fn() },
      namedExport: vi.fn(),
      // etc...
    }
  })
  ```

  - If `__mocks__` folder with file of the same name exist, all imports will return its exports. For example, `vi.mock('axios')` with `<root>/__mocks__/axios.ts` folder will return everything exported from `axios.ts`.
  - If there is no `__mocks__` folder or a file with the same name inside, will call original module and mock it. (For the rules applied, see [algorithm](/guide/mocking#automocking-algorithm).)

## vi.setSystemTime

- **Type**: `(date: string | number | Date) => void`

  Sets current date to the one that was passed. All `Date` calls will return this date.

  Useful if you need to test anything that depends on the current date - for example [luxon](https://github.com/moment/luxon/) calls inside your code.

  ```ts
  const date = new Date(1998, 11, 19)

  vi.useFakeTimers()
  vi.setSystemTime(date)

  expect(Date.now()).toBe(date.valueOf())

  vi.useRealTimers()
  ```

## vi.mocked

- **Type**: `<T>(obj: T, deep?: boolean) => MaybeMockedDeep<T>`

  Type helper for TypeScript. In reality just returns the object that was passed.

  ```ts
  import example from './example'
  vi.mock('./example')

  test('1+1 equals 2', async () => {
    vi.mocked(example.calc).mockRestore()

    const res = example.calc(1, '+', 1)

    expect(res).toBe(2)
  })
  ```

## vi.importActual

- **Type**: `<T>(path: string) => Promise<T>`

  Imports module, bypassing all checks if it should be mocked. Can be useful if you want to mock module partially.

  ```ts
  vi.mock('./example', async () => {
    const axios = await vi.importActual('./example')

    return { ...axios, get: vi.fn() }
  })
   ```

## vi.importMock

- **Type**: `<T>(path: string) => Promise<MaybeMockedDeep<T>>`

  Imports a module with all of its properties (including nested properties) mocked. Follows the same rules that [`vi.mock`](#vi-mock) follows. For the rules applied, see [algorithm](/guide/mocking#automocking-algorithm).

## vi.resetModules

- **Type**: `() => Vitest`

  Resets modules registry by clearing cache of all modules. Might be useful to isolate modules where local state conflicts between tests.

  ```ts
  import { vi } from 'vitest'

  beforeAll(() => {
    vi.resetModules()
  })

  test('change state', async () => {
    const mod = await import('./some/path')
    mod.changeLocalState('new value')
    expect(mod.getlocalState()).toBe('new value')
  })

  test('module has old state', async () => {
    const mod = await import('./some/path')
    expect(mod.getlocalState()).toBe('old value')
  })
  ```

## vi.restoreCurrentDate

- **Type**: `() => void`

  Restores `Date` back to its native implementation.

## vi.runAllTicks

- **Type:** `() => Vitest`

  Calls every microtask. These are usually queued by `proccess.nextTick`. This will also run all microtasks scheduled by themselves.

## vi.runAllTimers

- **Type:** `() => Vitest`

  This method will invoke every initiated timer until the timers queue is empty. It means that every timer called during `runAllTimers` will be fired. If you have an infinite interval,
  it will throw after 10 000 tries. For example this will log `1, 2, 3`:

  ```ts
  let i = 0
  setTimeout(() => console.log(++i))
  const interval = setInterval(() => {
    console.log(++i)
    if (i === 2)
      clearInterval(interval)

  }, 50)

  vi.runAllTimers()
  ```

## vi.runOnlyPendingTimers

- **Type:** `() => Vitest`

  This method will call every timer that was initiated after `vi.useFakeTimers()` call. It will not fire any timer that was initiated during its call. For example this will only log `1`:

  ```ts
  let i = 0
  setInterval(() => console.log(++i), 50)

  vi.runOnlyPendingTimers()
  ```

## vi.spyOn

- **Type:** `<T, K extends keyof T>(object: T, method: K, accessType?: 'get' | 'set') => MockInstance`

  Creates a spy on a method or getter/setter of an object.

  ```ts
  let apples = 0
  const obj = {
    getApples: () => 13,
  }

  const spy = vi.spyOn(obj, 'getApples').mockImplementation(() => apples)
  apples = 1

  expect(obj.getApples()).toBe(1)

  expect(spy).toHaveBeenCalled()
  expect(spy).toHaveReturnedWith(1)
  ```

## vi.stubGlobal

- **Type**: `(key: keyof globalThis & Window, value: any) => Vitest`

  Puts a value on global variable. If you are using `jsdom` or `happy-dom`, also puts the value on `window` object.

  Read more in ["Mocking Globals" section](/guide/mocking.html#globals).

## vi.unmock

- **Type**: `(path: string) => void`

  Removes module from mocked registry. All subsequent calls to import will return original module even if it was mocked.

## vi.useFakeTimers

- **Type:** `() => Vitest`

  To enable mocking timers, you need to call this method. It will wrap all further calls to timers (such as `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `nextTick`, `setImmediate`, `clearImmediate`, and `Date`), until [`vi.useRealTimers()`](#vi-userealtimers) is called.

  The implementation is based internally on [`@sinonjs/fake-timers`](https://github.com/sinonjs/fake-timers).

## vi.useRealTimers

- **Type:** `() => Vitest`

  When timers are run out, you may call this method to return mocked timers to its original implementations. All timers that were run before will not be restored.
