const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const root = process.cwd()
const { runProcessSync } = createRequire(path.join(root, 'package.json'))('@orca/process-host')
const output = path.resolve('ci-shards/runtime-comparison')
fs.mkdirSync(output, { recursive: true })
const files = [
  'src/main/browser/guest-lifecycle/popups/browser-popup-compatibility-electron-fixture.ts',
  'src/main/browser/guest-lifecycle/popups/browser-popup-native-compatibility.electron.test.ts',
  'src/main/browser/guest-lifecycle/popups/browser-popup-native-window.ts'
]
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const write = (name, value) =>
  fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2))
const command = (program, args) => {
  const result = runProcessSync({ program, args, cwd: root, timeoutMs: 60_000 })
  if (result.code !== 0 || result.outputTruncated || result.timedOut) {
    throw new Error(`${program} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

async function main() {
  const originalHead = command('git', ['rev-parse', 'HEAD'])
  const source = {
    head: originalHead,
    scenario: process.env.VALIDATION_SCENARIO,
    node: process.versions,
    os: { platform: process.platform, release: require('node:os').release() },
    runnerImage: process.env.ImageOS,
    runnerImageVersion: process.env.ImageVersion,
    git: command('git', ['--version']),
    bun: command('bun', ['--version']),
    pnpm: command('pnpm', ['--version']),
    lockfileSha256: hash('pnpm-lock.yaml'),
    backgroundLaunch: process.env.ORCA_BACKGROUND_LAUNCH,
    testSources: files
  }
  write('source.json', source)
  const patch = fs.readFileSync(path.join(__dirname, 'runtime-popup-inputs.patch'), 'utf8')
  const applied = runProcessSync({
    program: 'git',
    args: ['apply', '-'],
    cwd: root,
    input: patch.replace(/\r\n/g, '\n'),
    timeoutMs: 60_000
  })
  if (applied.code !== 0) {
    throw new Error(applied.stderr)
  }
  write('repair.json', {
    files: files.map((file) => ({ file, sha256: hash(file) })),
    diff: command('git', ['diff', '--name-only'])
  })
  const { planChangedChecks } = await import(
    pathToFileURL(
      path.join(root, 'config/scripts/preflight/changed-checks/check-changed-selection.mjs')
    ).href
  )
  const plan = planChangedChecks(files, {
    scriptsDir: path.join(root, 'config/scripts'),
    listDirectory: (directory) => fs.readdirSync(path.join(root, directory))
  })
  write('selection.json', plan.unitTests)
  if (plan.unitTests.colocated.length !== 0 || plan.unitTests.related.length !== 3) {
    throw new Error('Unexpected related selection; do not silently alter gate coverage')
  }
  const runs = []
  const run = (label, args) => {
    const stdoutFile = path.join(output, `${label}.stdout.log`)
    const stderrFile = path.join(output, `${label}.stderr.log`)
    const stdout = fs.openSync(stdoutFile, 'w')
    const stderr = fs.openSync(stderrFile, 'w')
    const started = Date.now()
    console.log(`Starting ${label}; complete streams go directly to artifact files`)
    let result
    try {
      result = runProcessSync({
        program: process.execPath,
        args,
        cwd: root,
        env: {
          ...process.env,
          ORCA_BACKGROUND_LAUNCH: '1',
          ORCA_DIFFERENTIAL_EVENTS: path.join(output, `${label}-events.jsonl`)
        },
        timeoutMs: 30 * 60_000,
        stdio: ['ignore', stdout, stderr]
      })
    } finally {
      fs.closeSync(stdout)
      fs.closeSync(stderr)
    }
    runs.push({
      label,
      program: process.execPath,
      argv: args,
      ...result,
      durationMs: Date.now() - started
    })
    write('runs.json', runs)
    console.log(`Finished ${label}: exit ${result.code}, ${Date.now() - started}ms`)
    return result
  }
  const ready = run('native-readiness', [
    'config/scripts/native-build/node-addons/ensure-native-runtime.mjs',
    '--runtime=node'
  ])
  if (ready.code !== 0) {
    throw new Error('Native readiness failed; test results would be invalid')
  }
  const result = run('related', [
    'config/scripts/test-runtime/execution-policy/run-vitest.mjs',
    'related',
    '--run',
    ...plan.unitTests.related,
    '--config',
    'config/vitest.config.ts',
    '--passWithNoTests',
    '--maxWorkers=2',
    '--reporter=default',
    '--reporter=json',
    `--reporter=${path.join(__dirname, 'reporter.mjs')}`,
    `--outputFile.json=${path.join(output, 'related-results.json')}`
  ])
  const resultFile = path.join(output, 'related-results.json')
  if (
    !fs.existsSync(resultFile) ||
    result.code === null ||
    result.timedOut ||
    result.outputTruncated
  ) {
    throw new Error(
      'Incomplete runtime comparison: structured result or complete process exit absent'
    )
  }
  const tests = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  write('summary.json', {
    passed: tests.numPassedTests,
    failed: tests.numFailedTests,
    pending: tests.numPendingTests,
    files: tests.testResults.length,
    exit: result.code,
    failures: tests.testResults.flatMap((file) =>
      file.assertionResults
        .filter((test) => test.status === 'failed')
        .map((test) => ({
          file: path.relative(root, file.name).split(path.sep).join('/'),
          ...test
        }))
    )
  })
  const manifestFiles = fs.readdirSync(output).sort()
  write('manifest.json', {
    completed: true,
    at: new Date().toISOString(),
    originalHead,
    files: manifestFiles.map((file) => ({
      file,
      bytes: fs.statSync(path.join(output, file)).size,
      sha256: hash(path.join(output, file))
    }))
  })
  console.log(
    JSON.stringify({
      passed: tests.numPassedTests,
      failed: tests.numFailedTests,
      files: tests.testResults.length,
      exit: result.code
    })
  )
  // Preserve failing test status; artifact upload runs independently with always().
  process.exitCode = result.code
}
main().catch((error) => {
  write('incomplete.json', { message: error.message, stack: error.stack })
  console.error(error)
  process.exitCode = 1
})
