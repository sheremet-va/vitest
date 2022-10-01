import { expectTypeOf } from 'vitest'

interface Thor {
  'name.first': string
  'name.first.second.third': string
}

expectTypeOf(45).toBe(45)
expectTypeOf(45).toBe<Thor['name.first']>(80)
expectTypeOf(45).toBe<Thor['name.first.second.third']>(80)

const test = {
  'name.first': {
    name: 'Thor',
  },
}

expectTypeOf(45)
  // test
  .toBe(45)

expectTypeOf<never>().toBeNever()
expectTypeOf('hren').toBe(45)
expectTypeOf({ wolk: 'true' }).toHaveProperty('wol')
expectTypeOf({ wolk: 'true' }).not.toHaveProperty('wol')
expectTypeOf((v): v is boolean => true).asserts.toBe<boolean>()
expectTypeOf({ wlk: 'true' }).toMatch({ msg: '' })
expectTypeOf((tut: string) => tut).toBeCallableWith(45)
expectTypeOf(Error).toBeConstructibleWith(test['name.first'].name, { tut: 'hamon' })