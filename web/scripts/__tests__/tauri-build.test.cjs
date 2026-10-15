'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')
const { prepareBuildEnv, runBuild, main } = require('../tauri-build.cjs')

const sdkDir = '/Library/Developer/CommandLineTools/SDKs'
const selectedSdk = `${sdkDir}/MacOSX27.0.sdk`

function harness({
  compatible = [selectedSdk],
  directories = {},
  aliases = {},
  selected = selectedSdk,
  child = { status: 0 },
} = {}) {
  const calls = []
  const messages = []
  const removed = []
  const fileSystem = {
    realpathSync: (filePath) => aliases[filePath] || filePath,
    readdirSync: (directory) => {
      if (Object.prototype.hasOwnProperty.call(directories, directory)) return directories[directory]
      throw Object.assign(new Error('Missing directory'), { code: 'ENOENT' })
    },
    mkdtempSync: () => '/tmp/msgnr-sdk-probe',
    rmSync: (directory, options) => removed.push({ directory, options }),
  }
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    if (command === 'xcrun' && args[0] === '--sdk') return { status: 0, stdout: selected }
    if (command === 'xcode-select') return { status: 0, stdout: '/Library/Developer/CommandLineTools' }
    if (command === 'xcrun' && args[0] === 'clang') {
      return compatible.includes(options.env.SDKROOT)
        ? { status: 0, stderr: '' }
        : { status: 1, stderr: 'ld: unknown architecture arm64e.x1' }
    }
    return child
  }
  return {
    options: { platform: 'darwin', env: { PATH: '/bin' }, spawn, fileSystem, tempDir: '/tmp', logger: { log: (message) => messages.push(message) } },
    calls, messages, removed,
    probes: () => calls.filter((call) => call.command === 'xcrun' && call.args[0] === 'clang'),
  }
}

test('prefers the selected SDK when it links and cleans up the probe', () => {
  const mock = harness()
  const env = prepareBuildEnv(mock.options)
  assert.deepEqual(env, { PATH: '/bin', SDKROOT: selectedSdk })
  assert.equal(mock.probes().length, 1)
  assert.equal(mock.calls.some((call) => call.command === 'xcode-select'), false)
  assert.deepEqual(mock.messages, [])
  assert.deepEqual(mock.removed, [{ directory: '/tmp/msgnr-sdk-probe', options: { recursive: true, force: true } }])
  const probe = mock.probes()[0]
  assert.equal(probe.options.input, 'int main(void) { return 0; }\n')
  assert.equal(probe.args[probe.args.indexOf('-isysroot') + 1], selectedSdk)
})

test('falls back through installed SDKs newest first and deduplicates symlinks', () => {
  const sdk26 = `${sdkDir}/MacOSX26.5.sdk`
  const sdk15 = `${sdkDir}/MacOSX15.4.sdk`
  const mock = harness({
    compatible: [sdk15],
    directories: { [sdkDir]: ['MacOSX15.sdk', 'MacOSX.sdk', 'MacOSX26.5.sdk', 'MacOSX15.4.sdk', 'MacOSX27.0.sdk', 'README'] },
    aliases: { [`${sdkDir}/MacOSX.sdk`]: selectedSdk, [`${sdkDir}/MacOSX15.sdk`]: sdk15 },
  })
  assert.equal(prepareBuildEnv(mock.options).SDKROOT, sdk15)
  assert.deepEqual(mock.probes().map((call) => call.options.env.SDKROOT), [selectedSdk, sdk26, sdk15])
  assert.match(mock.messages[0], /using .*MacOSX15\.4\.sdk/)
  assert.equal(mock.removed.length, 3)
})

test('discovers full Xcode SDKs while respecting DEVELOPER_DIR', () => {
  const developerDir = '/Applications/Xcode.app/Contents/Developer'
  const xcodeSdkDir = `${developerDir}/Platforms/MacOSX.platform/Developer/SDKs`
  const fallback = `${xcodeSdkDir}/MacOSX26.5.sdk`
  const mock = harness({ compatible: [fallback], directories: { [xcodeSdkDir]: ['MacOSX26.5.sdk'] } })
  assert.equal(prepareBuildEnv({ ...mock.options, env: { DEVELOPER_DIR: developerDir } }).SDKROOT, fallback)
  assert.equal(mock.calls.some((call) => call.command === 'xcode-select'), false)
})

test('preserves explicit SDKROOT and non-macOS environments without probing', () => {
  for (const options of [
    { platform: 'darwin', env: { SDKROOT: '/custom/sdk', DEVELOPER_DIR: '/custom/tools' } },
    { platform: 'darwin', env: { SDKROOT: '' } },
    { platform: 'linux', env: { PATH: '/bin' } },
    { platform: 'win32', env: { PATH: 'C:\\tools' } },
  ]) {
    const mock = harness()
    assert.equal(prepareBuildEnv({ ...mock.options, ...options }), options.env)
    assert.deepEqual(mock.calls, [])
  }
})

test('reports an actionable error when no installed SDK can link', () => {
  const mock = harness({ compatible: [] })
  assert.throws(() => prepareBuildEnv(mock.options), /No installed macOS SDK can link[\s\S]*Update Command Line Tools\/Xcode[\s\S]*SDKROOT[\s\S]*unknown architecture/)
  assert.equal(mock.removed.length, 1)
})

test('runs the local CLI with forwarded arguments and selected environment', () => {
  const mock = harness({ child: { status: 23 } })
  const result = runBuild({ ...mock.options, args: ['--target', 'aarch64-apple-darwin', '--bundles', 'app'], nodeExecutable: '/node', cliPath: '/local/tauri.js' })
  assert.equal(result.status, 23)
  const child = mock.calls.at(-1)
  assert.equal(child.command, '/node')
  assert.deepEqual(child.args, ['/local/tauri.js', 'build', '--verbose', '--config', 'src-tauri/tauri.conf.json', '--target', 'aarch64-apple-darwin', '--bundles', 'app'])
  assert.equal(child.options.cwd, path.resolve(__dirname, '../..'))
  assert.equal(child.options.env.SDKROOT, selectedSdk)
  assert.equal(child.options.env.CI, 'true')
  assert.equal(mock.options.env.CI, undefined)
  assert.equal(child.options.stdio, 'inherit')

  const help = harness()
  runBuild({ ...help.options, args: ['--help'], nodeExecutable: '/node', cliPath: '/local/tauri.js' })
  assert.equal(help.probes().length, 0)
  assert.equal(help.calls.at(-1).options.env, help.options.env)
  assert.equal(help.calls.at(-1).args.includes('--verbose'), false)
})

test('preserves explicit CI and Finder settings without duplicating verbosity flags', () => {
  for (const verbosity of ['--verbose', '-v', '-vv']) {
    const mock = harness()
    const env = { SDKROOT: '/custom/sdk', CI: 'false', TAURI_BUNDLER_DMG_IGNORE_CI: 'true' }
    runBuild({ ...mock.options, env, args: [verbosity], nodeExecutable: '/node', cliPath: '/local/tauri.js' })
    const child = mock.calls.at(-1)
    assert.equal(child.options.env, env)
    assert.deepEqual(child.args, ['/local/tauri.js', 'build', '--config', 'src-tauri/tauri.conf.json', verbosity])
  }
})

test('keeps CI and verbosity unchanged on Linux and Windows', () => {
  for (const platform of ['linux', 'win32']) {
    const mock = harness()
    runBuild({ ...mock.options, platform, args: [], nodeExecutable: '/node', cliPath: '/local/tauri.js' })
    const child = mock.calls.at(-1)
    assert.equal(child.options.env, mock.options.env)
    assert.deepEqual(child.args, ['/local/tauri.js', 'build', '--config', 'src-tauri/tauri.conf.json'])
    assert.deepEqual(mock.probes(), [])
  }
})

test('propagates child exit status and signals and reports spawn errors', () => {
  for (const [child, expected] of [
    [{ status: 7 }, { exits: [7], kills: [], errors: [] }],
    [{ status: null, signal: 'SIGTERM' }, { exits: [], kills: [[123, 'SIGTERM']], errors: [] }],
    [{ status: null, error: new Error('CLI missing') }, { exits: [1], kills: [], errors: ['[tauri-build] CLI missing'] }],
    [{ status: null }, { exits: [1], kills: [], errors: [] }],
  ]) {
    const mock = harness({ child })
    const actual = { exits: [], kills: [], errors: [] }
    main({
      ...mock.options, platform: 'linux', args: [], nodeExecutable: '/node', cliPath: '/local/tauri.js',
      processImpl: { pid: 123, exit: (code) => actual.exits.push(code), kill: (...args) => actual.kills.push(args) },
      logger: { error: (message) => actual.errors.push(message) },
    })
    assert.deepEqual(actual, expected)
  }
})
