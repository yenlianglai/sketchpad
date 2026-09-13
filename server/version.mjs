// The version, read from package.json rather than repeated.
//
// It was written out by hand in six places, which is five opportunities for the number an agent is
// told to stop matching the number that was released.

import { readFileSync } from 'node:fs'

export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version
