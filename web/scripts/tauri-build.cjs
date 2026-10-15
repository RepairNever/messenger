'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const rootDir = path.resolve(__dirname, '..')

function commandOutput(spawn, command, args, env) {
  const result = spawn(command, args, { env, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0 || !result.stdout?.trim()) {
    throw new Error(result.stderr?.trim() || `${command} ${args.join(' ')} failed`)
  }
  return result.stdout.trim()
}

function sdkVersion(sdkPath) {
  const match = /^MacOSX(\d+(?:\.\d+)*)\.sdk$/.exec(path.basename(sdkPath))
  return match ? match[1].split('.').map(Number) : []
}

function compareSdkVersions(left, right) {
  const leftVersion = sdkVersion(left)
  const rightVersion = sdkVersion(right)
  for (let index = 0; index < Math.max(leftVersion.length, rightVersion.length); index += 1) {
    const difference = (rightVersion[index] || 0) - (leftVersion[index] || 0)
    if (difference) return difference
  }
  return left.localeCompare(right)
}

function probeSdk(sdkPath, { env, spawn, fileSystem, tempDir }) {
  const probeDir = fileSystem.mkdtempSync(path.join(tempDir, 'msgnr-tauri-sdk-'))
  try {
    const result = spawn('xcrun', [
      'clang', '-x', 'c', '-', '-o', path.join(probeDir, 'probe'),
      '-isysroot', sdkPath, '-framework', 'AppKit',
    ], {
      env: { ...env, SDKROOT: sdkPath },
      encoding: 'utf8',
      input: 'int main(void) { return 0; }\n',
    })
    return {
      compatible: !result.error && result.status === 0,
      reason: result.error?.message || result.stderr?.trim() || `link probe exited with ${result.signal || result.status}`,
    }
  } finally {
    fileSystem.rmSync(probeDir, { recursive: true, force: true })
  }
}

function prepareBuildEnv({
  platform = process.platform,
  env = process.env,
  spawn = spawnSync,
  fileSystem = fs,
  tempDir = os.tmpdir(),
  logger = console,
} = {}) {
  if (platform !== 'darwin' || Object.prototype.hasOwnProperty.call(env, 'SDKROOT')) return env

  const deps = { env, spawn, fileSystem, tempDir }
  const failures = []
  let selectedSdk
  try {
    selectedSdk = fileSystem.realpathSync(commandOutput(spawn, 'xcrun', ['--sdk', 'macosx', '--show-sdk-path'], env))
  } catch (error) {
    failures.push(`Selected SDK: ${error.message}`)
  }

  const checked = new Set()
  function compatible(sdkPath) {
    checked.add(sdkPath)
    const result = probeSdk(sdkPath, deps)
    if (result.compatible) return true
    failures.push(`${sdkPath}: ${result.reason.split('\n').slice(0, 3).join('\n')}`)
    return false
  }

  if (selectedSdk && compatible(selectedSdk)) return { ...env, SDKROOT: selectedSdk }

  let developerDir
  try {
    developerDir = env.DEVELOPER_DIR || commandOutput(spawn, 'xcode-select', ['--print-path'], env)
  } catch (error) {
    failures.push(`Developer directory: ${error.message}`)
  }

  const sdkDirs = new Set(selectedSdk ? [path.dirname(selectedSdk)] : [])
  if (developerDir) {
    sdkDirs.add(path.join(developerDir, 'SDKs'))
    sdkDirs.add(path.join(developerDir, 'Platforms', 'MacOSX.platform', 'Developer', 'SDKs'))
  }

  const candidates = new Set()
  for (const sdkDir of sdkDirs) {
    let entries
    try {
      entries = fileSystem.readdirSync(sdkDir)
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue
      throw error
    }
    for (const entry of entries) {
      if (!/^MacOSX(?:\d+(?:\.\d+)*)?\.sdk$/.test(entry)) continue
      try {
        const sdkPath = fileSystem.realpathSync(path.join(sdkDir, entry))
        if (!checked.has(sdkPath)) candidates.add(sdkPath)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  }

  for (const sdkPath of [...candidates].sort(compareSdkVersions)) {
    if (compatible(sdkPath)) {
      logger.log(`[tauri-build] The default macOS SDK could not link; using ${sdkPath}`)
      return { ...env, SDKROOT: sdkPath }
    }
  }

  throw new Error([
    'No installed macOS SDK can link with the selected developer tools.',
    'Update Command Line Tools/Xcode, or set SDKROOT to a compatible installed SDK and retry.',
    ...failures,
  ].join('\n'))
}

function runBuild({
  args = process.argv.slice(2),
  platform = process.platform,
  nodeExecutable = process.execPath,
  cliPath = require.resolve('@tauri-apps/cli/tauri.js'),
  spawn = spawnSync,
  env = process.env,
  ...options
} = {}) {
  const infoOnly = args.some((arg) => ['--help', '-h', '--version', '-V'].includes(arg))
  let buildEnv = infoOnly
    ? env
    : prepareBuildEnv({ ...options, platform, env, spawn })
  // Tauri's DMG bundler reads CI directly to skip Finder's cosmetic AppleScript.
  if (!infoOnly && platform === 'darwin' && !Object.prototype.hasOwnProperty.call(buildEnv, 'CI')) {
    buildEnv = { ...buildEnv, CI: 'true' }
  }
  const verbosityArgs = !infoOnly && platform === 'darwin'
    && !args.some((arg) => arg === '--verbose' || /^-v+$/.test(arg))
    ? ['--verbose']
    : []
  const result = spawn(nodeExecutable, [
    cliPath, 'build', ...verbosityArgs, '--config', 'src-tauri/tauri.conf.json', ...args,
  ], { cwd: rootDir, env: buildEnv, stdio: 'inherit' })
  if (result.error) throw result.error
  return result
}

function main({ processImpl = process, logger = console, ...options } = {}) {
  try {
    const result = runBuild({ ...options, logger })
    if (result.signal) {
      processImpl.kill(processImpl.pid, result.signal)
      return
    }
    processImpl.exit(typeof result.status === 'number' ? result.status : 1)
  } catch (error) {
    logger.error(`[tauri-build] ${error.message}`)
    processImpl.exit(1)
  }
}

module.exports = { prepareBuildEnv, runBuild, main }

if (require.main === module) main()
