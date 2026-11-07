const fs = require('node:fs'),
  path = require('node:path'),
  util = require('node:util')
const { spawnSync } = require('node:child_process')
const targets = require('./targets.json')
const remainingTwo = process.env.ORCA_DIAG_REMAINING_TWO === '1'
const applyFix = process.env.ORCA_DIAG_APPLY_POPUP_FIX === '1'
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
if (applyFix) {
  const patch = fs.readFileSync(path.join(__dirname, 'popup-fixture-fix.patch'), 'utf8')
  const applied = spawnSync('git', ['apply', '-'], {
    encoding: 'utf8',
    input: patch.replace(/\r\n/g, '\n')
  })
  if (applied.status !== 0) {
    throw new Error(applied.stderr)
  }
  const file =
    'src/main/browser/guest-lifecycle/popups/browser-popup-compatibility-electron-fixture.ts'
  fs.writeFileSync(
    path.join(output, 'repair.json'),
    JSON.stringify(
      {
        file,
        patchCrlfLines: patch.split('\r\n').length - 1,
        sha256: require('node:crypto')
          .createHash('sha256')
          .update(fs.readFileSync(file))
          .digest('hex')
      },
      null,
      2
    )
  )
}
if (remainingTwo) {
  const started = Date.now()
  const python = spawnSync(
    'python3',
    [
      '-c',
      'import sys, json, encodings, urllib.request, http.server, ssl; print(json.dumps({"executable":sys.executable,"version":sys.version}))'
    ],
    { encoding: 'utf8', timeout: 30000 }
  )
  fs.writeFileSync(
    path.join(output, 'python.json'),
    JSON.stringify(
      {
        status: python.status,
        stdout: python.stdout,
        stderr: python.stderr,
        durationMs: Date.now() - started,
        error: python.error && util.inspect(python.error)
      },
      null,
      2
    )
  )
  if (python.status !== 0) {
    throw new Error('Python stdlib probe failed; Hermes must not silently return')
  }
}
const originalFiles = new Map()
const edit = (file, before, after) => {
  const source = fs.readFileSync(file, 'utf8')
  if (!originalFiles.has(file)) {
    originalFiles.set(file, source)
  }
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
if (remainingTwo) {
  edit(
    'src/main/hermes/hook-service.test.ts',
    "'import importlib.util',",
    "'import importlib.util, sys, time',\n          'print(\"DIAG_HERMES_PYTHON_START\", time.monotonic(), file=sys.stderr, flush=True)',"
  )
  edit(
    'src/main/hermes/hook-service.test.ts',
    "'spec.loader.exec_module(mod)',",
    "'spec.loader.exec_module(mod)',\n          'print(\"DIAG_HERMES_PLUGIN_IMPORTED\", time.monotonic(), file=sys.stderr, flush=True)',"
  )
  edit(
    'src/main/hermes/hook-service.test.ts',
    '(error) => {\n            if (!error)',
    '(error, stdout, stderr) => {\n            console.error("DIAG_HERMES_CHILD_EXIT", JSON.stringify({ at: Date.now(), error: error && String(error), stdout, stderr }))\n            if (!error)'
  )
  edit(
    'src/main/browser/guest-lifecycle/popups/browser-popup-compatibility-cdp-fixture.ts',
    'stderr += data.toString()',
    "stderr += data.toString()\n    console.error('DIAG_ELECTRON_STDERR', data.toString())"
  )
  edit(
    'src/main/browser/guest-lifecycle/popups/browser-popup-compatibility-cdp-fixture.ts',
    "fixture.stderr?.on('data',",
    "fixture.once('exit', (code, signal) => console.error('DIAG_ELECTRON_EXIT', JSON.stringify({ code, signal, stderr })))\n  fixture.stderr?.on('data',"
  )
  edit(
    'src/main/browser/guest-lifecycle/popups/browser-popup-compatibility-electron-fixture.ts',
    "process.on('uncaughtException', (error) => {",
    "process.on('uncaughtException', (error) => {\n  console.error('DIAG_UNCAUGHT', error)"
  )
  edit(
    'src/main/browser/guest-lifecycle/popups/browser-popup-compatibility-electron-fixture.ts',
    "process.on('unhandledRejection', (error) => {",
    "process.on('unhandledRejection', (error) => {\n  console.error('DIAG_REJECTION', error)"
  )
  edit(
    'src/main/browser/guest-lifecycle/popups/browser-popup-compatibility-electron-fixture.ts',
    'function writeStatus(error?: string): void {',
    "function writeStatus(error?: string): void {\n  if (error !== undefined) console.error('DIAG_STATUS_ARGUMENT', error)"
  )
  edit(
    'src/main/browser/guest-lifecycle/popups/browser-popup-compatibility-electron-fixture.ts',
    'async function run(): Promise<void> {',
    "async function run(): Promise<void> {\n  app.on('web-contents-created', (_event, contents) => {\n    const id = contents.id\n    contents.on('did-fail-load', (_event, code, description, url) => console.error('DIAG_LOAD_FAILED', JSON.stringify({ id, code, description, url })))\n    contents.on('render-process-gone', (_event, details) => console.error('DIAG_RENDERER_GONE', JSON.stringify({ id, details })))\n  })"
  )
  edit(
    'src/main/browser/guest-lifecycle/popups/browser-popup-background-cdp-probe.ts',
    'const page = guest(control ? `${name}-control` : name)',
    "console.error('DIAG_PROBE', JSON.stringify({ name, probe, control }))\n  const page = guest(control ? `${name}-control` : name)"
  )
}
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
if (remainingTwo) {
  edit(
    'src/main/browser/guest-lifecycle/popups/browser-popup-compatibility-cdp-fixture.ts',
    'afterAll(async () => {\n  cdpConnected.resolve()',
    'afterAll(async () => {\n  const diagnosticDir = process.env.ORCA_DIAG_POPUP_STATUS_DIR\n  if (diagnosticDir && existsSync(statusPath)) {\n    mkdirSync(diagnosticDir, { recursive: true })\n    writeFileSync(join(diagnosticDir, "status.json"), JSON.stringify({ status: status(), receipts, snapshots }, null, 2))\n  }\n  cdpConnected.resolve()'
  )
}
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const pattern = targets
  .filter((t) => t.id !== 9)
  .map((t) => escape(t.title))
  .concat('background popup|GET|POST|Shift|middle|modifier|context|popup|Ctrl|Meta')
  .join('|')
const files = targets.map((t) => t.file)
const runs = []
function run(label, args, command = 'test') {
  const logfile = path.join(output, `${label}.log`),
    fd = fs.openSync(logfile, 'w')
  const env = {
    ...process.env,
    ORCA_DIFFERENTIAL_EVENTS: path.join(output, `${label}-events.jsonl`),
    ...(remainingTwo ? { ORCA_DIAG_POPUP_STATUS_DIR: path.join(output, `${label}-electron`) } : {})
  }
  const argv = [
    command,
    ...args,
    ...(command === 'test'
      ? [
          '--maxWorkers=1',
          '--no-file-parallelism',
          '--reporter=default',
          '--reporter=json',
          `--reporter=${path.join(__dirname, 'reporter.mjs')}`,
          `--outputFile.json=${path.join(output, `${label}-results.json`)}`
        ]
      : [])
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
if (remainingTwo) {
  for (let round = 1; round <= 3; round++) {
    run(
      `remaining-two-${round}`,
      targets.filter((t) => t.id === 9).map((t) => t.file)
    )
  }
} else {
  for (let round = 1; round <= 2; round++) {
    run(`selected-${round}`, [...files, '-t', pattern])
  }
  run('clone-predecessors', [
    'src/main/runtime/orca-runtime.test.ts',
    '-t',
    'clone|clones|cloning|submodule cache'
  ])
}
if (applyFix) {
  run('related-popups', [
    'src/main/browser/guest-lifecycle/popups/browser-popup-compatibility.electron.test.ts',
    'src/main/browser/guest-lifecycle/popups/browser-popup-native-compatibility.electron.test.ts',
    'src/main/browser/guest-lifecycle/popups/browser-popup-adapter-compatibility.electron.test.ts'
  ])
  for (const [file, source] of originalFiles) {
    fs.writeFileSync(file, source)
  }
  run('changed-check', ['--base=HEAD', '--maxWorkers=2', '--timeout=10'], 'check:changed')
}
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
if (applyFix && runs.some((run) => run.exit !== 0)) {
  process.exitCode = 1
}
