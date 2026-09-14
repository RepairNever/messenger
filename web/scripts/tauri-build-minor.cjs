'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const rootDir = path.resolve(__dirname, '..')
const tauriConfigPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json')
const cargoTomlPath = path.join(rootDir, 'src-tauri', 'Cargo.toml')
const packageJsonPath = path.join(rootDir, 'package.json')

function parseVersion(version, sourceName) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) {
    throw new Error(`Unsupported ${sourceName} version format: "${version}". Expected x.y.z.`)
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

function nextMinorVersion(version) {
  const parsed = parseVersion(version, 'tauri')
  return `${parsed.major}.${parsed.minor + 1}.0`
}

function updateJsonVersion(filePath, nextVersion, key = 'version') {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  data[key] = nextVersion
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function updateCargoVersion(filePath, nextVersion) {
  const cargo = fs.readFileSync(filePath, 'utf8')
  const packageSectionVersion = /^version\s*=\s*"(\d+\.\d+\.\d+)"\s*$/m
  if (!packageSectionVersion.test(cargo)) {
    throw new Error('Could not find package version in Cargo.toml')
  }
  const updated = cargo.replace(packageSectionVersion, `version = "${nextVersion}"`)
  fs.writeFileSync(filePath, updated, 'utf8')
}

function runBuild() {
  const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(cmd, ['run', 'tauri:build'], {
    cwd: rootDir,
    stdio: 'inherit',
  })

  if (result.error) {
    throw result.error
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status)
  }
}

function main() {
  const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'))
  const currentVersion = tauriConfig.version
  const nextVersion = nextMinorVersion(currentVersion)

  updateJsonVersion(tauriConfigPath, nextVersion)
  updateCargoVersion(cargoTomlPath, nextVersion)
  updateJsonVersion(packageJsonPath, nextVersion)

  console.log(`[tauri-build-minor] Version bumped: ${currentVersion} -> ${nextVersion}`)
  runBuild()
}

main()
