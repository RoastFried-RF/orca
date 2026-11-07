const fs = require('node:fs'),
  path = require('node:path'),
  util = require('node:util')
const { spawnSync } = require('node:child_process')
const targets = require('./targets.json')
const output = path.resolve('ci-shards/differential')
fs.mkdirSync(output, { recursive: true })
const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
fs.writeFileSync(
  path.join(output, 'source.json'),
  JSON.stringify(
    { head, scenario: process.env.VALIDATION_SCENARIO, node: process.versions, targets },
    null,
    2
  )
)
const edit = (file, before, after) => {
  const source = fs.readFileSync(file, 'utf8')
  if (!source.includes(before)) {
    throw new Error(`Diagnostic anchor missing: ${file}`)
  }
  fs.writeFileSync(file, source.replace(before, after))
}
// Diagnostics change error detail only; existing assertions and timeouts remain intact.
edit(
  'src/main/runtime/orca-runtime-tests/repository-project-operations-part-02.spec.ts',
  "createRuntime().cloneRepo(join(destination, 'missing', 'orca'), destination)\n      ).rejects.toThrow('Clone failed')",
  "createRuntime().cloneRepo(join(destination, 'missing', 'orca'), destination)\n      ).rejects.toThrow('Clone failed')\n      console.error('DIAG_CLONE_CALLS', JSON.stringify(spawnSpy.mock.calls.map(call => call[0])))"
)
edit(
  'src/main/hermes/hook-service.test.ts',
  "new Error('timed out waiting for Hermes plugin POST')",
  "new Error('timed out waiting for Hermes plugin POST; child/startup/import/POST share the existing 5000ms budget')"
)
edit(
  'src/main/browser/guest-lifecycle/popups/browser-popup-compatibility-electron-fixture.ts',
  'writeStatus(String(error))\n  app.exit(1)\n})',
  "writeStatus(JSON.stringify({ phase, error: require('node:util').inspect(error, { depth: 8 }), stack: error instanceof Error ? error.stack : undefined }))\n  app.exit(1)\n})"
)
edit(
  'src/main/browser/guest-lifecycle/popups/browser-popup-compatibility-electron-fixture.ts',
  'void run().catch((error: unknown) => {\n  writeStatus(String(error))',
  "void run().catch((error: unknown) => {\n  writeStatus(JSON.stringify({ phase, error: require('node:util').inspect(error, { depth: 8 }), stack: error instanceof Error ? error.stack : undefined }))"
)
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const pattern = targets
  .filter((t) => t.id !== 9)
  .map((t) => escape(t.title))
  .concat('background popup|GET|POST|Shift|middle|modifier|context|popup|Ctrl|Meta')
  .join('|')
const files = targets.map((t) => t.file)
const runs = []
function run(label, args) {
  const logfile = path.join(output, `${label}.log`),
    fd = fs.openSync(logfile, 'w')
  const env = {
    ...process.env,
    ORCA_DIFFERENTIAL_EVENTS: path.join(output, `${label}-events.jsonl`)
  }
  const argv = [
    'test',
    ...args,
    '--maxWorkers=1',
    '--no-file-parallelism',
    '--reporter=default',
    '--reporter=json',
    `--reporter=${path.join(__dirname, 'reporter.mjs')}`,
    `--outputFile.json=${path.join(output, `${label}-results.json`)}`
  ]
  console.log(`Starting ${label}`)
  const started = Date.now()
  const argsFile = path.join(output, `${label}-argv.json`)
  fs.writeFileSync(argsFile, JSON.stringify(argv))
  // Pass arguments as data so regex metacharacters never become shell syntax.
  env.ORCA_DIAG_ARGV = argsFile
  const child = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$testArgs = @(Get-Content -LiteralPath $env:ORCA_DIAG_ARGV -Raw | ConvertFrom-Json); & pnpm @testArgs; exit $LASTEXITCODE'
    ],
    { env, stdio: ['ignore', fd, fd], timeout: 900000 }
  )
  fs.closeSync(fd)
  runs.push({
    label,
    argv,
    exit: child.status,
    durationMs: Date.now() - started,
    error: child.error && util.inspect(child.error)
  })
  fs.writeFileSync(path.join(output, 'runs.json'), JSON.stringify(runs, null, 2))
  console.log(`Finished ${label}: ${child.status}, ${Date.now() - started}ms`)
}
// Run exact cases twice, then preserve clone predecessor ordering in a separate invocation.
for (let round = 1; round <= 2; round++) {
  run(`selected-${round}`, [...files, '-t', pattern])
}
run('clone-predecessors', [
  'src/main/runtime/orca-runtime.test.ts',
  '-t',
  'clone|clones|cloning|submodule cache'
])
const summaries = []
for (const run of runs) {
  const filename = path.join(output, `${run.label}-results.json`)
  if (!fs.existsSync(filename)) {
    summaries.push({ label: run.label, missing: true })
    continue
  }
  const data = JSON.parse(fs.readFileSync(filename))
  summaries.push({
    label: run.label,
    passed: data.numPassedTests,
    failed: data.numFailedTests,
    pending: data.numPendingTests,
    failures: data.testResults.flatMap((f) =>
      f.assertionResults
        .filter((t) => t.status === 'failed')
        .map((t) => ({ file: f.name, title: t.title, messages: t.failureMessages }))
    ),
    suiteErrors: data.testResults
      .filter((f) => f.message)
      .map((f) => ({ file: f.name, message: f.message }))
  })
}
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summaries, null, 2))
// Expected baseline defects are evidence, not a reason to discard paired artifacts.
console.log(
  JSON.stringify(
    summaries.map(({ label, passed, failed, pending, missing }) => ({
      label,
      passed,
      failed,
      pending,
      missing
    }))
  )
)
