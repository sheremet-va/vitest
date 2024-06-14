import type { File, Task, TaskResultPack } from '@vitest/runner'

// can't import actual functions from utils, because it's incompatible with @vitest/browsers
import { createFileTask } from '@vitest/runner/utils'
import type { AggregateError as AggregateErrorPonyfill } from '../utils/base'
import type { UserConsoleLog } from '../types/general'
import type { WorkspaceProject } from './workspace'

export function isAggregateError(err: unknown): err is AggregateErrorPonyfill {
  if (typeof AggregateError !== 'undefined' && err instanceof AggregateError) {
    return true
  }

  return err instanceof Error && 'errors' in err
}

// Note this file is shared for both node and browser, be aware to avoid node specific logic
export class StateManager {
  filesMap = new Map<string, File[]>()
  pathsSet: Set<string> = new Set()
  idMap = new Map<string, Task>()
  taskFileMap = new WeakMap<Task, File>()
  errorsSet = new Set<unknown>()
  processTimeoutCauses = new Set<string>()

  catchError(err: unknown, type: string): void {
    if (isAggregateError(err)) {
      return err.errors.forEach(error => this.catchError(error, type))
    }

    if (err === Object(err)) {
      (err as Record<string, unknown>).type = type
    }
    else {
      err = { type, message: err }
    }

    const _err = err as Record<string, any>
    if (_err && typeof _err === 'object' && _err.code === 'VITEST_PENDING') {
      const task = this.idMap.get(_err.taskId)
      if (task) {
        task.mode = 'skip'
        task.result ??= { state: 'skip' }
        task.result.state = 'skip'
      }
      return
    }

    this.errorsSet.add(err)
  }

  clearErrors() {
    this.errorsSet.clear()
  }

  getUnhandledErrors() {
    return Array.from(this.errorsSet.values())
  }

  addProcessTimeoutCause(cause: string) {
    this.processTimeoutCauses.add(cause)
  }

  getProcessTimeoutCauses() {
    return Array.from(this.processTimeoutCauses.values())
  }

  getPaths() {
    return Array.from(this.pathsSet)
  }

  getFiles(keys?: string[]): File[] {
    if (keys) {
      return keys
        .map(key => this.filesMap.get(key)!)
        .filter(Boolean)
        .flat()
    }
    return Array.from(this.filesMap.values()).flat()
  }

  getFilepaths(): string[] {
    return Array.from(this.filesMap.keys())
  }

  getFailedFilepaths() {
    return this.getFiles()
      .filter(i => i.result?.state === 'fail')
      .map(i => i.filepath)
  }

  collectPaths(paths: string[] = []) {
    paths.forEach((path) => {
      this.pathsSet.add(path)
    })
  }

  collectFiles(files: File[] = []) {
    files.forEach((file) => {
      const existing = this.filesMap.get(file.filepath) || []
      const otherProject = existing.filter(
        i => i.projectName !== file.projectName,
      )
      const currentFile = existing.find(
        i => i.projectName === file.projectName,
      )
      // keep logs for the previous file because it should alway be initiated before the collections phase
      // which means that all logs are collected during the collection and not inside tests
      if (currentFile) {
        file.logs = currentFile.logs
      }
      otherProject.push(file)
      this.filesMap.set(file.filepath, otherProject)
      this.updateId(file)
    })
  }

  // this file is reused by ws-client, and shoult not rely on heavy dependencies like workspace
  clearFiles(
    _project: { config: { name: string | undefined; root: string } },
    paths: string[] = [],
  ) {
    const project = _project as WorkspaceProject
    paths.forEach((path) => {
      const files = this.filesMap.get(path)
      const fileTask = createFileTask(
        path,
        project.config.root,
        project.config.name,
      )
      this.idMap.set(fileTask.id, fileTask)
      if (!files) {
        this.filesMap.set(path, [fileTask])
        return
      }
      const filtered = files.filter(
        file => file.projectName !== project.config.name,
      )
      // always keep a File task, so we can associate logs with it
      if (!filtered.length) {
        this.filesMap.set(path, [fileTask])
      }
      else {
        this.filesMap.set(path, [...filtered, fileTask])
      }
    })
  }

  updateId(task: Task) {
    if (this.idMap.get(task.id) === task) {
      return
    }
    this.idMap.set(task.id, task)
    if (task.type === 'suite') {
      task.tasks.forEach((task) => {
        this.updateId(task)
      })
    }
  }

  updateTasks(packs: TaskResultPack[]) {
    for (const [id, result, meta] of packs) {
      const task = this.idMap.get(id)
      if (task) {
        task.result = result
        task.meta = meta
        // skipped with new PendingError
        if (result?.state === 'skip') {
          task.mode = 'skip'
        }
      }
    }
  }

  updateUserLog(log: UserConsoleLog) {
    const task = log.taskId && this.idMap.get(log.taskId)
    if (task) {
      if (!task.logs) {
        task.logs = []
      }
      task.logs.push(log)
    }
  }

  getCountOfFailedTests() {
    return Array.from(this.idMap.values()).filter(
      t => t.result?.state === 'fail',
    ).length
  }

  cancelFiles(files: string[], root: string, projectName: string) {
    this.collectFiles(
      files.map(filepath => createFileTask(filepath, root, projectName)),
    )
  }
}
