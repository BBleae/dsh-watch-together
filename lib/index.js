// dsh-watch-together — the meta package.
//
// It carries no behaviour of its own: the five service plugins are the stack,
// and each of them fails on its own so a dead microphone does not blind the
// eyes. What this package adds is the one thing that used to be missing - a
// single install that pulls all of them in, in dependency order, so nobody has
// to know the topology before they can start watching.
export const name = 'dsh-watch-stack'

export const inject = []

export const services = [
  'dsh-watch-eyes',
  'dsh-watch-ears',
  'dsh-watch-mouth',
  'dsh-watch-browser',
  'dsh-watch-hands',
  'dsh-watch-panel',
]

export function apply() {
  // Nothing to mount: each sibling ships its own cordis patch, and the profile
  // composition already discovered them as dependencies. Doing it again here
  // would mount every service twice.
}
