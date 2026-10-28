/**
 * Matchers jest-dom pour Vitest 5 : le `vitest.d.ts` de jest-dom augmente
 * `Assertion<T>`, dont la signature a changé ; on augmente `Matchers<R, T>`.
 */
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  /* eslint-disable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars -- signature imposée par Vitest */
  interface Matchers<
    R extends void | Promise<void> = void | Promise<void>,
    T = unknown,
  > extends TestingLibraryMatchers<unknown, R> {}
  /* eslint-enable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars */
}
