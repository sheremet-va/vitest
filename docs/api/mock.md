# Mock API

You can create mock by calling [`vi.fn()`](/api/vi#vi-fn) or [`vi.spyOn`](/api/vi#vi-spyon).

## getMockName

- **Type:** `() => string`

  Use it to return the name given to mock with method `.mockName(name)`.

## mockClear

- **Type:** `() => MockInstance`

  Clears all information about every call. After calling it, [`spy.mock.calls`](#mock-calls), [`spy.mock.results`](#mock-results) will return empty arrays. It is useful if you need to clean up spy between different assertions.

  If you want this method to be called before each test automatically, you can enable [`clearMocks`](/config/#clearmocks) setting in config.


## mockName

- **Type:** `(name: string) => MockInstance`

  Sets internal mock name. Useful to see what mock has failed the assertion.

## mockImplementation

- **Type:** `(fn: Function) => MockInstance`

  Accepts a function that will be used as an implementation of the mock.

  For example:

  ```ts
  const mockFn = vi.fn().mockImplementation(apples => apples + 1)
  // or: vi.fn(apples => apples + 1);

  const NelliesBucket = mockFn(0)
  const BobsBucket = mockFn(1)

  NelliesBucket === 1 // true
  BobsBucket === 2 // true

  mockFn.mock.calls[0][0] === 0 // true
  mockFn.mock.calls[1][0] === 1 // true
  ```

## mockImplementationOnce

- **Type:** `(fn: Function) => MockInstance`

  Accepts a function that will be used as an implementation of the mock for one call to the mocked function. Can be chained so that multiple function calls produce different results.

  ```ts
  const myMockFn = vi
    .fn()
    .mockImplementationOnce(() => true)
    .mockImplementationOnce(() => false)

  myMockFn() // true
  myMockFn() // false
  ```

  When the mocked function runs out of implementations, it will invoke the default implementation that was set with `vi.fn(() => defaultValue)` or `.mockImplementation(() => defaultValue)` if they were called:

  ```ts
  const myMockFn = vi
    .fn(() => 'default')
    .mockImplementationOnce(() => 'first call')
    .mockImplementationOnce(() => 'second call')

  // 'first call', 'second call', 'default', 'default'
  console.log(myMockFn(), myMockFn(), myMockFn(), myMockFn())
  ```

## mockRejectedValue

- **Type:** `(value: any) => MockInstance`

  Accepts an error that will be rejected, when async function will be called.

  ```ts
  test('async test', async () => {
    const asyncMock = vi.fn().mockRejectedValue(new Error('Async error'))

    await asyncMock() // throws "Async error"
  })
  ```

## mockRejectedValueOnce

- **Type:** `(value: any) => MockInstance`

  Accepts a value that will be rejected for one call to the mock function. If chained, every consecutive call will reject passed value.

  ```ts
  test('async test', async () => {
    const asyncMock = vi
      .fn()
      .mockResolvedValueOnce('first call')
      .mockRejectedValueOnce(new Error('Async error'))

    await asyncMock() // first call
    await asyncMock() // throws "Async error"
  })
  ```

## mockReset

- **Type:** `() => MockInstance`

  Does what `mockClear` does and makes inner implementation as an empty function (returning `undefined`, when invoked). This is useful when you want to completely reset a mock back to its initial state.

  If you want this method to be called before each test automatically, you can enable [`mockReset`](/config/#mockreset) setting in config.

## mockRestore

- **Type:** `() => MockInstance`

  Does what `mockReset` does and restores inner implementation to the original function.

  Note that restoring mock from `vi.fn()` will set implementation to an empty function that returns `undefined`. Restoring a `vi.fn(impl)` will restore implementation to `impl`.

  If you want this method to be called before each test automatically, you can enable [`restoreMocks`](/config/#restoreMocks) setting in config.

## mockResolvedValue

- **Type:** `(value: any) => MockInstance`

  Accepts a value that will be resolved, when async function will be called.

  ```ts
  test('async test', async () => {
    const asyncMock = vi.fn().mockResolvedValue(43)

    await asyncMock() // 43
  })
  ```

## mockResolvedValueOnce

- **Type:** `(value: any) => MockInstance`

  Accepts a value that will be resolved for one call to the mock function. If chained, every consecutive call will resolve passed value.

  ```ts
  test('async test', async () => {
    const asyncMock = vi
      .fn()
      .mockResolvedValue('default')
      .mockResolvedValueOnce('first call')
      .mockResolvedValueOnce('second call')

    await asyncMock() // first call
    await asyncMock() // second call
    await asyncMock() // default
    await asyncMock() // default
  })
  ```

## mockReturnThis

- **Type:** `() => MockInstance`

  Sets inner implementation to return `this` context.

## mockReturnValue

- **Type:** `(value: any) => MockInstance`

  Accepts a value that will be returned whenever the mock function is called.

  ```ts
  const mock = vi.fn()
  mock.mockReturnValue(42)
  mock() // 42
  mock.mockReturnValue(43)
  mock() // 43
  ```

## mockReturnValueOnce

- **Type:** `(value: any) => MockInstance`

  Accepts a value that will be returned for one call to the mock function. If chained, every consecutive call will return passed value. When there are no more `mockReturnValueOnce` values to use, calls a function specified by `mockImplementation` or other `mockReturn*` methods.

  ```ts
  const myMockFn = vi
    .fn()
    .mockReturnValue('default')
    .mockReturnValueOnce('first call')
    .mockReturnValueOnce('second call')

  // 'first call', 'second call', 'default', 'default'
  console.log(myMockFn(), myMockFn(), myMockFn(), myMockFn())
  ```

## mock.calls

This is an array containing all arguments for each call. One item of the array is arguments of that call.

If a function was invoked twice with the following arguments `fn(arg1, arg2)`, `fn(arg3, arg4)` in that order, then `mock.calls` will be:

```js
[
  ['arg1', 'arg2'],
  ['arg3', 'arg4'],
]
```

## mock.lastCall

This contains the arguments of the last call. If spy wasn't called, will return `undefined`.

## mock.results

This is an array containing all values, that were `returned` from function. One item of the array is an object with properties `type` and `value`. Available types are:

- `'return'` - function returned without throwing.
- `'throw'` - function threw a value.

The `value` property contains returned value or thrown error.

If function returned `result`, then threw an error, then `mock.results` will be:

```js
[
  {
    type: 'return',
    value: 'result',
  },
  {
    type: 'throw',
    value: Error,
  },
]
```

## mock.instances

This is an array containing all instances that were instantiated when mock was called with a `new` keyword. Note, this is an actual context (`this`) of the function, not a return value.

For example, if mock was instantiated with `new MyClass()`, then `mock.instances` will be an array of one value:

```js
import { expect, vi } from 'vitest'

const MyClass = vi.fn()

const a = new MyClass()

expect(MyClass.mock.instances[0]).toBe(a)
```

If you return a value from constructor, it will not be in `instances` array, but instead on `results`:

```js
import { expect, vi } from 'vitest'

const Spy = vi.fn(() => ({ method: vi.fn() }))

const a = new Spy()

expect(Spy.mock.instances[0]).not.toBe(a)
expect(Spy.mock.results[0]).toBe(a)
```
