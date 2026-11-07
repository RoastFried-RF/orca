import { appendFileSync } from 'node:fs'

export default class DifferentialReporter {
  write(event, entity, extra = {}) {
    if (!process.env.ORCA_DIFFERENTIAL_EVENTS) {
      return
    }
    appendFileSync(
      process.env.ORCA_DIFFERENTIAL_EVENTS,
      `${JSON.stringify({
        at: new Date().toISOString(),
        event,
        file: entity?.module?.moduleId ?? entity?.moduleId,
        name: entity?.fullName ?? entity?.name,
        ...extra
      })}\n`
    )
  }
  onHookStart(hook) {
    this.write('hook-start', hook.entity, { hook: hook.name, result: hook.entity.result?.() })
  }
  onHookEnd(hook) {
    this.write('hook-end', hook.entity, { hook: hook.name, result: hook.entity.result?.() })
  }
  onTestCaseResult(test) {
    if (test.result().state !== 'skipped') {
      this.write('test-result', test, { result: test.result(), diagnostic: test.diagnostic() })
    }
  }
  onTestModuleEnd(module) {
    this.write('module-end', module, { errors: module.errors() })
  }
  onTestRunEnd(_modules, errors) {
    this.write('run-end', null, { errors })
  }
}
