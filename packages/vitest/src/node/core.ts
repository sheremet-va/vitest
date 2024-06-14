import { existsSync, promises as fs } from 'node:fs'
import type { Writable } from 'node:stream'
import { isMainThread } from 'node:worker_threads'
import type { ViteDevServer } from 'vite'
import { mergeConfig } from 'vite'
import { basename, dirname, join, normalize, relative, resolve } from 'pathe'
import fg from 'fast-glob'
import mm from 'micromatch'
import c from 'picocolors'
import { ViteNodeRunner } from 'vite-node/client'
import { SnapshotManager } from '@vitest/snapshot/manager'
import type { CancelReason, File, TaskResultPack } from '@vitest/runner'
import { ViteNodeServer } from 'vite-node/server'
import type { defineWorkspace } from 'vitest/config'
import { version } from '../../package.json' with { type: 'json' }
import type { ArgumentsType, CoverageProvider, OnServerRestartHandler, Reporter, ResolvedConfig, SerializableSpec, UserConfig, UserConsoleLog, UserWorkspaceConfig, VitestRunMode } from '../types'
import { getTasks, hasFailed, noop, slash, toArray, wildcardPatternToRegExp } from '../utils'
import { getCoverageProvider } from '../integrations/coverage'
import { CONFIG_NAMES, configFiles, workspacesFiles as workspaceFiles } from '../constants'
import { rootDir } from '../paths'
import { WebSocketReporter } from '../api/setup'
import { createPool } from './pool'
import type { ProcessPool, WorkspaceSpec } from './pool'
import { createBenchmarkReporters, createReporters } from './reporters/utils'
import { StateManager } from './state'
import { resolveConfig } from './config'
import { Logger } from './logger'
import { VitestCache } from './cache'
import { WorkspaceProject, initializeProject } from './workspace'
import { VitestPackageInstaller } from './packageInstaller'
import { BlobReporter, readBlobs } from './reporters/blob'

const WATCHER_DEBOUNCE = 100

export interface VitestOptions {
  packageInstaller?: VitestPackageInstaller
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream | Writable
  stderr?: NodeJS.WriteStream | Writable
}

export class Vitest {
  version = version

  config: ResolvedConfig = undefined!
  configOverride: Partial<ResolvedConfig> = {}

  server: ViteDevServer = undefined!
  state: StateManager = undefined!
  snapshot: SnapshotManager = undefined!
  cache: VitestCache = undefined!
  reporters: Reporter[] = undefined!
  coverageProvider: CoverageProvider | null | undefined
  logger: Logger
  pool: ProcessPool | undefined

  vitenode: ViteNodeServer = undefined!

  invalidates: Set<string> = new Set()
  changedTests: Set<string> = new Set()
  watchedTests: Set<string> = new Set()
  filenamePattern?: string
  runningPromise?: Promise<void>
  closingPromise?: Promise<void>
  isCancelling = false

  isFirstRun = true
  restartsCount = 0
  runner: ViteNodeRunner = undefined!

  public packageInstaller: VitestPackageInstaller

  private coreWorkspaceProject!: WorkspaceProject

  private resolvedProjects: WorkspaceProject[] = []
  public projects: WorkspaceProject[] = []
  private projectsTestFiles = new Map<string, Set<WorkspaceProject>>()

  public distPath!: string

  constructor(
    public readonly mode: VitestRunMode,
    options: VitestOptions = {},
  ) {
    this.logger = new Logger(this, options.stdout, options.stderr)
    this.packageInstaller = options.packageInstaller || new VitestPackageInstaller()
  }

  private _onRestartListeners: OnServerRestartHandler[] = []
  private _onClose: (() => Awaited<unknown>)[] = []
  private _onSetServer: OnServerRestartHandler[] = []
  private _onCancelListeners: ((reason: CancelReason) => Promise<void> | void)[] = []

  async setServer(options: UserConfig, server: ViteDevServer, cliOptions: UserConfig) {
    this.unregisterWatcher?.()
    clearTimeout(this._rerunTimer)
    this.restartsCount += 1
    this.pool?.close?.()
    this.pool = undefined
    this.coverageProvider = undefined
    this.runningPromise = undefined
    this.distPath = undefined!
    this.projectsTestFiles.clear()

    const resolved = resolveConfig(this.mode, options, server.config, this.logger)

    this.server = server
    this.config = resolved
    this.state = new StateManager()
    this.cache = new VitestCache(this.version)
    this.snapshot = new SnapshotManager({ ...resolved.snapshotOptions })

    if (this.config.watch) {
      this.registerWatcher()
    }

    this.vitenode = new ViteNodeServer(server, this.config.server)

    const node = this.vitenode
    this.runner = new ViteNodeRunner({
      root: server.config.root,
      base: server.config.base,
      fetchModule(id: string) {
        return node.fetchModule(id)
      },
      resolveId(id: string, importer?: string) {
        return node.resolveId(id, importer)
      },
    })

    if (this.config.watch) {
      // hijack server restart
      const serverRestart = server.restart
      server.restart = async (...args) => {
        await Promise.all(this._onRestartListeners.map(fn => fn()))
        await serverRestart(...args)
        // watcher is recreated on restart
        this.unregisterWatcher()
        this.registerWatcher()
      }

      // since we set `server.hmr: false`, Vite does not auto restart itself
      server.watcher.on('change', async (file) => {
        file = normalize(file)
        const isConfig = file === server.config.configFile
        if (isConfig) {
          await Promise.all(this._onRestartListeners.map(fn => fn('config')))
          await serverRestart()
          // watcher is recreated on restart
          this.unregisterWatcher()
          this.registerWatcher()
        }
      })
    }

    this.reporters = resolved.mode === 'benchmark'
      ? await createBenchmarkReporters(toArray(resolved.benchmark?.reporters), this.runner)
      : await createReporters(resolved.reporters, this)

    this.cache.results.setConfig(resolved.root, resolved.cache)
    try {
      await this.cache.results.readFromCache()
    }
    catch { }

    await Promise.all(this._onSetServer.map(fn => fn()))

    const projects = await this.resolveWorkspace(cliOptions)
    this.resolvedProjects = projects
    this.projects = projects
    const filters = toArray(resolved.project).map(s => wildcardPatternToRegExp(s))
    if (filters.length > 0) {
      this.projects = this.projects.filter(p =>
        filters.some(pattern => pattern.test(p.getName())),
      )
    }
    if (!this.coreWorkspaceProject) {
      this.coreWorkspaceProject = WorkspaceProject.createBasicProject(this)
    }

    if (this.config.testNamePattern) {
      this.configOverride.testNamePattern = this.config.testNamePattern
    }
  }

  private async createCoreProject() {
    this.coreWorkspaceProject = await WorkspaceProject.createCoreProject(this)
    return this.coreWorkspaceProject
  }

  public getCoreWorkspaceProject(): WorkspaceProject {
    return this.coreWorkspaceProject
  }

  public getProjectByTaskId(taskId: string): WorkspaceProject {
    const task = this.state.idMap.get(taskId)
    const projectName = (task as File).projectName || task?.file?.projectName || ''
    return this.projects.find(p => p.getName() === projectName)
      || this.getCoreWorkspaceProject()
      || this.projects[0]
  }

  public getProjectByName(name: string = '') {
    return this.projects.find(p => p.getName() === name)
      || this.getCoreWorkspaceProject()
      || this.projects[0]
  }

  private async getWorkspaceConfigPath() {
    if (this.config.workspace) {
      return this.config.workspace
    }

    const configDir = this.server.config.configFile
      ? dirname(this.server.config.configFile)
      : this.config.root

    const rootFiles = await fs.readdir(configDir)

    const workspaceConfigName = workspaceFiles.find((configFile) => {
      return rootFiles.includes(configFile)
    })

    if (!workspaceConfigName) {
      return null
    }

    return join(configDir, workspaceConfigName)
  }

  private async resolveWorkspace(cliOptions: UserConfig) {
    const workspaceConfigPath = await this.getWorkspaceConfigPath()

    if (!workspaceConfigPath) {
      return [await this.createCoreProject()]
    }

    const workspaceModule = await this.runner.executeFile(workspaceConfigPath) as {
      default: ReturnType<typeof defineWorkspace>
    }

    if (!workspaceModule.default || !Array.isArray(workspaceModule.default)) {
      throw new Error(`Workspace config file ${workspaceConfigPath} must export a default array of project paths.`)
    }

    const workspaceGlobMatches: string[] = []
    const projectsOptions: UserWorkspaceConfig[] = []

    for (const project of workspaceModule.default) {
      if (typeof project === 'string') {
        workspaceGlobMatches.push(project.replace('<rootDir>', this.config.root))
      }
      else if (typeof project === 'function') {
        projectsOptions.push(await project({
          command: this.server.config.command,
          mode: this.server.config.mode,
          isPreview: false,
          isSsrBuild: false,
        }))
      }
      else {
        projectsOptions.push(await project)
      }
    }

    const globOptions: fg.Options = {
      absolute: true,
      dot: true,
      onlyFiles: false,
      markDirectories: true,
      cwd: this.config.root,
      ignore: ['**/node_modules/**', '**/*.timestamp-*'],
    }

    const workspacesFs = await fg(workspaceGlobMatches, globOptions)
    const resolvedWorkspacesPaths = await Promise.all(workspacesFs.filter((file) => {
      if (file.endsWith('/')) {
        // if it's a directory, check that we don't already have a workspace with a config inside
        const hasWorkspaceWithConfig = workspacesFs.some((file2) => {
          return file2 !== file && `${dirname(file2)}/` === file
        })
        return !hasWorkspaceWithConfig
      }
      const filename = basename(file)
      return CONFIG_NAMES.some(configName => filename.startsWith(configName))
    }).map(async (filepath) => {
      if (filepath.endsWith('/')) {
        const filesInside = await fs.readdir(filepath)
        const configFile = configFiles.find(config => filesInside.includes(config))
        return configFile ? join(filepath, configFile) : filepath
      }
      return filepath
    }))

    const workspacesByFolder = resolvedWorkspacesPaths
      .reduce((configByFolder, filepath) => {
        const dir = filepath.endsWith('/') ? filepath.slice(0, -1) : dirname(filepath)
        configByFolder[dir] ??= []
        configByFolder[dir].push(filepath)
        return configByFolder
      }, {} as Record<string, string[]>)

    const filteredWorkspaces = Object.values(workspacesByFolder).map((configFiles) => {
      if (configFiles.length === 1) {
        return configFiles[0]
      }
      const vitestConfig = configFiles.find(configFile => basename(configFile).startsWith('vitest.config'))
      return vitestConfig || configFiles[0]
    })

    const overridesOptions = [
      'logHeapUsage',
      'allowOnly',
      'sequence',
      'testTimeout',
      'pool',
      'update',
      'globals',
      'expandSnapshotDiff',
      'disableConsoleIntercept',
      'retry',
      'testNamePattern',
      'passWithNoTests',
      'bail',
      'isolate',
      'printConsoleTrace',
    ] as const

    const cliOverrides = overridesOptions.reduce((acc, name) => {
      if (name in cliOptions) {
        acc[name] = cliOptions[name] as any
      }
      return acc
    }, {} as UserConfig)

    const cwd = process.cwd()

    const projects: WorkspaceProject[] = []

    try {
      // we have to resolve them one by one because CWD should depend on the project
      for (const filepath of filteredWorkspaces) {
        if (this.server.config.configFile === filepath) {
          const project = await this.createCoreProject()
          projects.push(project)
          continue
        }
        const dir = filepath.endsWith('/') ? filepath.slice(0, -1) : dirname(filepath)
        if (isMainThread) {
          process.chdir(dir)
        }
        projects.push(
          await initializeProject(filepath, this, { workspaceConfigPath, test: cliOverrides }),
        )
      }
    }
    finally {
      if (isMainThread) {
        process.chdir(cwd)
      }
    }

    const projectPromises: Promise<WorkspaceProject>[] = []

    projectsOptions.forEach((options, index) => {
      // we can resolve these in parallel because process.cwd() is not changed
      projectPromises.push(initializeProject(index, this, mergeConfig(options, { workspaceConfigPath, test: cliOverrides }) as any))
    })

    if (!projects.length && !projectPromises.length) {
      return [await this.createCoreProject()]
    }

    const resolvedProjects = await Promise.all([
      ...projects,
      ...await Promise.all(projectPromises),
    ])
    const names = new Set<string>()

    for (const project of resolvedProjects) {
      const name = project.getName()
      if (names.has(name)) {
        throw new Error(`Project name "${name}" is not unique. All projects in a workspace should have unique names.`)
      }
      names.add(name)
    }

    return resolvedProjects
  }

  private async initCoverageProvider() {
    if (this.coverageProvider !== undefined) {
      return
    }
    this.coverageProvider = await getCoverageProvider(this.config.coverage, this.runner)
    if (this.coverageProvider) {
      await this.coverageProvider.initialize(this)
      this.config.coverage = this.coverageProvider.resolveOptions()
    }
    return this.coverageProvider
  }

  private async initBrowserProviders() {
    return Promise.all(this.projects.map(w => w.initBrowserProvider()))
  }

  async mergeReports() {
    if (this.reporters.some(r => r instanceof BlobReporter)) {
      throw new Error('Cannot merge reports when `--reporter=blob` is used. Remove blob reporter from the config first.')
    }

    const { files, errors, coverages } = await readBlobs(this.config.mergeReports, this.projects)

    await this.report('onInit', this)
    await this.report('onPathsCollected', files.flatMap(f => f.filepath))

    const workspaceSpecs = new Map<WorkspaceProject, File[]>()
    for (const file of files) {
      const project = this.getProjectByName(file.projectName)
      const specs = workspaceSpecs.get(project) || []
      specs.push(file)
      workspaceSpecs.set(project, specs)
    }

    for (const [project, files] of workspaceSpecs) {
      const filepaths = files.map(f => f.filepath)
      this.state.clearFiles(project, filepaths)
      files.forEach((file) => {
        file.logs?.forEach(log => this.state.updateUserLog(log))
      })
      this.state.collectFiles(files)
    }

    await this.report('onCollected', files).catch(noop)

    for (const file of files) {
      const logs: UserConsoleLog[] = []
      const taskPacks: TaskResultPack[] = []

      const tasks = getTasks(file)
      for (const task of tasks) {
        if (task.logs) {
          logs.push(...task.logs)
        }
        taskPacks.push([task.id, task.result, task.meta])
      }
      logs.sort((log1, log2) => log1.time - log2.time)

      for (const log of logs) {
        await this.report('onUserConsoleLog', log).catch(noop)
      }

      await this.report('onTaskUpdate', taskPacks).catch(noop)
    }

    if (hasFailed(files)) {
      process.exitCode = 1
    }

    await this.report('onFinished', files, errors)
    await this.initCoverageProvider()
    await this.coverageProvider?.mergeReports?.(coverages)
  }

  async start(filters?: string[]) {
    this._onClose = []

    try {
      await this.initCoverageProvider()
      await this.coverageProvider?.clean(this.config.coverage.clean)
      await this.initBrowserProviders()
    }
    finally {
      await this.report('onInit', this)
    }

    const files = await this.filterTestsBySource(
      await this.globTestFiles(filters),
    )

    // if run with --changed, don't exit if no tests are found
    if (!files.length) {
      // Report coverage for uncovered files
      const coverage = await this.coverageProvider?.generateCoverage?.({ allTestsRun: true })
      await this.reportCoverage(coverage, true)

      this.logger.printNoTestFound(filters)

      if (!this.config.watch || !(this.config.changed || this.config.related?.length)) {
        const exitCode = this.config.passWithNoTests ? 0 : 1
        process.exit(exitCode)
      }
    }

    if (files.length) {
      // populate once, update cache on watch
      await this.cache.stats.populateStats(this.config.root, files)

      await this.runFiles(files, true)
    }

    if (this.config.watch) {
      await this.report('onWatcherStart')
    }
  }

  async init() {
    this._onClose = []

    try {
      await this.initCoverageProvider()
      await this.coverageProvider?.clean(this.config.coverage.clean)
      await this.initBrowserProviders()
    }
    finally {
      await this.report('onInit', this)
    }

    // populate test files cache so watch mode can trigger a file rerun
    await this.globTestFiles()

    if (this.config.watch) {
      await this.report('onWatcherStart')
    }
  }

  private async getTestDependencies(filepath: WorkspaceSpec, deps = new Set<string>()) {
    const addImports = async ([project, filepath]: WorkspaceSpec) => {
      if (deps.has(filepath)) {
        return
      }
      deps.add(filepath)

      const mod = project.server.moduleGraph.getModuleById(filepath)
      const transformed = mod?.ssrTransformResult || await project.vitenode.transformRequest(filepath)
      if (!transformed) {
        return
      }
      const dependencies = [...transformed.deps || [], ...transformed.dynamicDeps || []]
      await Promise.all(dependencies.map(async (dep) => {
        const path = await project.server.pluginContainer.resolveId(dep, filepath, { ssr: true })
        const fsPath = path && !path.external && path.id.split('?')[0]
        if (fsPath && !fsPath.includes('node_modules') && !deps.has(fsPath) && existsSync(fsPath)) {
          await addImports([project, fsPath])
        }
      }))
    }

    await addImports(filepath)
    deps.delete(filepath[1])

    return deps
  }

  async filterTestsBySource(specs: WorkspaceSpec[]) {
    if (this.config.changed && !this.config.related) {
      const { VitestGit } = await import('./git')
      const vitestGit = new VitestGit(this.config.root)
      const related = await vitestGit.findChangedFiles({
        changedSince: this.config.changed,
      })
      if (!related) {
        this.logger.error(c.red('Could not find Git root. Have you initialized git with `git init`?\n'))
        process.exit(1)
      }
      this.config.related = Array.from(new Set(related))
    }

    const related = this.config.related
    if (!related) {
      return specs
    }

    const forceRerunTriggers = this.config.forceRerunTriggers
    if (forceRerunTriggers.length && mm(related, forceRerunTriggers).length) {
      return specs
    }

    // don't run anything if no related sources are found
    // if we are in watch mode, we want to process all tests
    if (!this.config.watch && !related.length) {
      return []
    }

    const testGraphs = await Promise.all(
      specs.map(async (spec) => {
        const deps = await this.getTestDependencies(spec)
        return [spec, deps] as const
      }),
    )

    const runningTests = []

    for (const [filepath, deps] of testGraphs) {
      // if deps or the test itself were changed
      if (related.some(path => path === filepath[1] || deps.has(path))) {
        runningTests.push(filepath)
      }
    }

    return runningTests
  }

  getProjectsByTestFile(file: string) {
    const projects = this.projectsTestFiles.get(file)
    if (!projects) {
      return []
    }
    return Array.from(projects).map(project => [project, file] as WorkspaceSpec)
  }

  async initializeGlobalSetup(paths: WorkspaceSpec[]) {
    const projects = new Set(paths.map(([project]) => project))
    const coreProject = this.getCoreWorkspaceProject()
    if (!projects.has(coreProject)) {
      projects.add(coreProject)
    }
    for await (const project of projects) {
      await project.initializeGlobalSetup()
    }
  }

  private async initializeDistPath() {
    if (this.distPath) {
      return
    }

    // if Vitest is running globally, then we should still import local vitest if possible
    const projectVitestPath = await this.vitenode.resolveId('vitest')
    const vitestDir = projectVitestPath ? resolve(projectVitestPath.id, '../..') : rootDir
    this.distPath = join(vitestDir, 'dist')
  }

  async runFiles(specs: WorkspaceSpec[], allTestsRun: boolean) {
    await this.initializeDistPath()

    const filepaths = specs.map(([, file]) => file)
    this.state.collectPaths(filepaths)

    await this.report('onPathsCollected', filepaths)
    await this.report('onSpecsCollected', specs.map(
      ([project, file]) =>
        [{ name: project.config.name, root: project.config.root }, file] as SerializableSpec,
    ))

    // previous run
    await this.runningPromise
    this._onCancelListeners = []
    this.isCancelling = false

    // schedule the new run
    this.runningPromise = (async () => {
      if (!this.pool) {
        this.pool = createPool(this)
      }

      const invalidates = Array.from(this.invalidates)
      this.invalidates.clear()
      this.snapshot.clear()
      this.state.clearErrors()

      if (!this.isFirstRun && this.config.coverage.cleanOnRerun) {
        await this.coverageProvider?.clean()
      }

      await this.initializeGlobalSetup(specs)

      try {
        await this.pool.runTests(specs, invalidates)
      }
      catch (err) {
        this.state.catchError(err, 'Unhandled Error')
      }

      const files = this.state.getFiles()

      if (hasFailed(files)) {
        process.exitCode = 1
      }

      this.cache.results.updateResults(files)
      await this.cache.results.writeToCache()
    })()
      .finally(async () => {
        // can be duplicate files if different projects are using the same file
        const files = Array.from(new Set(specs.map(([, p]) => p)))
        const coverage = await this.coverageProvider?.generateCoverage({ allTestsRun })

        await this.report('onFinished', this.state.getFiles(files), this.state.getUnhandledErrors(), coverage)
        await this.reportCoverage(coverage, allTestsRun)

        this.runningPromise = undefined
        this.isFirstRun = false

        // all subsequent runs will treat this as a fresh run
        this.config.changed = false
        this.config.related = undefined
      })

    return await this.runningPromise
  }

  async cancelCurrentRun(reason: CancelReason) {
    this.isCancelling = true
    await Promise.all(this._onCancelListeners.splice(0).map(listener => listener(reason)))
  }

  async rerunFiles(files: string[] = this.state.getFilepaths(), trigger?: string) {
    if (this.filenamePattern) {
      const filteredFiles = await this.globTestFiles([this.filenamePattern])
      files = files.filter(file => filteredFiles.some(f => f[1] === file))
    }

    await this.report('onWatcherRerun', files, trigger)
    await this.runFiles(files.flatMap(file => this.getProjectsByTestFile(file)), !trigger)

    await this.report('onWatcherStart', this.state.getFiles(files))
  }

  async changeProjectName(pattern: string) {
    if (pattern === '') {
      delete this.configOverride.project
    }
    else { this.configOverride.project = pattern }

    this.projects = this.resolvedProjects.filter(p => p.getName() === pattern)
    const files = (await this.globTestFiles()).map(([, file]) => file)
    await this.rerunFiles(files, 'change project filter')
  }

  async changeNamePattern(pattern: string, files: string[] = this.state.getFilepaths(), trigger?: string) {
    // Empty test name pattern should reset filename pattern as well
    if (pattern === '') {
      this.filenamePattern = undefined
    }

    const testNamePattern = pattern ? new RegExp(pattern) : undefined
    this.configOverride.testNamePattern = testNamePattern
    // filter only test files that have tests matching the pattern
    if (testNamePattern) {
      files = files.filter((filepath) => {
        const files = this.state.getFiles([filepath])
        return !files.length || files.some((file) => {
          const tasks = getTasks(file)
          return !tasks.length || tasks.some(task => testNamePattern.test(task.name))
        })
      })
    }
    await this.rerunFiles(files, trigger)
  }

  async changeFilenamePattern(pattern: string, files: string[] = this.state.getFilepaths()) {
    this.filenamePattern = pattern

    const trigger = this.filenamePattern ? 'change filename pattern' : 'reset filename pattern'

    await this.rerunFiles(files, trigger)
  }

  async rerunFailed() {
    await this.rerunFiles(this.state.getFailedFilepaths(), 'rerun failed')
  }

  async updateSnapshot(files?: string[]) {
    // default to failed files
    files = files || [
      ...this.state.getFailedFilepaths(),
      ...this.snapshot.summary.uncheckedKeysByFile.map(s => s.filePath),
    ]

    this.configOverride.snapshotOptions = {
      updateSnapshot: 'all',
      // environment is resolved inside a worker thread
      snapshotEnvironment: null as any,
    }

    try {
      await this.rerunFiles(files, 'update snapshot')
    }
    finally {
      delete this.configOverride.snapshotOptions
    }
  }

  private _rerunTimer: any
  private async scheduleRerun(triggerId: string[]) {
    const currentCount = this.restartsCount
    clearTimeout(this._rerunTimer)
    await this.runningPromise
    clearTimeout(this._rerunTimer)

    // server restarted
    if (this.restartsCount !== currentCount) {
      return
    }

    this._rerunTimer = setTimeout(async () => {
      // run only watched tests
      if (this.watchedTests.size) {
        this.changedTests.forEach((test) => {
          if (!this.watchedTests.has(test)) {
            this.changedTests.delete(test)
          }
        })
      }

      if (this.changedTests.size === 0) {
        this.invalidates.clear()
        return
      }

      // server restarted
      if (this.restartsCount !== currentCount) {
        return
      }

      this.isFirstRun = false

      this.snapshot.clear()
      let files = Array.from(this.changedTests)

      if (this.filenamePattern) {
        const filteredFiles = await this.globTestFiles([this.filenamePattern])
        files = files.filter(file => filteredFiles.some(f => f[1] === file))

        // A file that does not match the current filename pattern was changed
        if (files.length === 0) {
          return
        }
      }

      this.changedTests.clear()

      const triggerIds = new Set(triggerId.map(id => relative(this.config.root, id)))
      const triggerLabel = Array.from(triggerIds).join(', ')
      await this.report('onWatcherRerun', files, triggerLabel)

      await this.runFiles(files.flatMap(file => this.getProjectsByTestFile(file)), false)

      await this.report('onWatcherStart', this.state.getFiles(files))
    }, WATCHER_DEBOUNCE)
  }

  public getModuleProjects(filepath: string) {
    return this.projects.filter((project) => {
      return project.getModulesByFilepath(filepath).size
      // TODO: reevaluate || project.browser?.moduleGraph.getModulesByFile(id)?.size
    })
  }

  /**
   * Watch only the specified tests. If no tests are provided, all tests will be watched.
   */
  public watchTests(tests: string[]) {
    this.watchedTests = new Set(
      tests.map(test => slash(test)),
    )
  }

  private unregisterWatcher = noop
  private registerWatcher() {
    const updateLastChanged = (filepath: string) => {
      const projects = this.getModuleProjects(filepath)
      projects.forEach(({ server, browser }) => {
        const serverMods = server.moduleGraph.getModulesByFile(filepath)
        serverMods?.forEach(mod => server.moduleGraph.invalidateModule(mod))

        if (browser) {
          const browserMods = browser.moduleGraph.getModulesByFile(filepath)
          browserMods?.forEach(mod => browser.moduleGraph.invalidateModule(mod))
        }
      })
    }

    const onChange = (id: string) => {
      id = slash(id)
      this.logger.clearHighlightCache(id)
      updateLastChanged(id)
      const needsRerun = this.handleFileChanged(id)
      if (needsRerun.length) {
        this.scheduleRerun(needsRerun)
      }
    }
    const onUnlink = (id: string) => {
      id = slash(id)
      this.logger.clearHighlightCache(id)
      this.invalidates.add(id)

      if (this.state.filesMap.has(id)) {
        this.state.filesMap.delete(id)
        this.cache.results.removeFromCache(id)
        this.cache.stats.removeStats(id)
        this.changedTests.delete(id)
        this.report('onTestRemoved', id)
      }
    }
    const onAdd = async (id: string) => {
      id = slash(id)
      updateLastChanged(id)

      const matchingProjects: WorkspaceProject[] = []
      await Promise.all(this.projects.map(async (project) => {
        if (await project.isTargetFile(id)) {
          matchingProjects.push(project)
          project.testFilesList?.push(id)
        }
      }))

      if (matchingProjects.length > 0) {
        this.projectsTestFiles.set(id, new Set(matchingProjects))
        this.changedTests.add(id)
        this.scheduleRerun([id])
      }
      else {
        // it's possible that file was already there but watcher triggered "add" event instead
        const needsRerun = this.handleFileChanged(id)
        if (needsRerun.length) {
          this.scheduleRerun(needsRerun)
        }
      }
    }
    const watcher = this.server.watcher

    if (this.config.forceRerunTriggers.length) {
      watcher.add(this.config.forceRerunTriggers)
    }

    watcher.on('change', onChange)
    watcher.on('unlink', onUnlink)
    watcher.on('add', onAdd)

    this.unregisterWatcher = () => {
      watcher.off('change', onChange)
      watcher.off('unlink', onUnlink)
      watcher.off('add', onAdd)
      this.unregisterWatcher = noop
    }
  }

  /**
   * @returns A value indicating whether rerun is needed (changedTests was mutated)
   */
  private handleFileChanged(filepath: string): string[] {
    if (this.changedTests.has(filepath) || this.invalidates.has(filepath)) {
      return []
    }

    if (mm.isMatch(filepath, this.config.forceRerunTriggers)) {
      this.state.getFilepaths().forEach(file => this.changedTests.add(file))
      return [filepath]
    }

    const projects = this.getModuleProjects(filepath)
    if (!projects.length) {
      // if there are no modules it's possible that server was restarted
      // we don't have information about importers anymore, so let's check if the file is a test file at least
      if (this.state.filesMap.has(filepath) || this.projects.some(project => project.isTestFile(filepath))) {
        this.changedTests.add(filepath)
        return [filepath]
      }
      return []
    }

    const files: string[] = []

    for (const project of projects) {
      const mods = project.getModulesByFilepath(filepath)
      if (!mods.size) {
        continue
      }

      this.invalidates.add(filepath)

      // one of test files that we already run, or one of test files that we can run
      if (this.state.filesMap.has(filepath) || project.isTestFile(filepath)) {
        this.changedTests.add(filepath)
        files.push(filepath)
        continue
      }

      let rerun = false
      for (const mod of mods) {
        mod.importers.forEach((i) => {
          if (!i.file) {
            return
          }

          const heedsRerun = this.handleFileChanged(i.file)
          if (heedsRerun.length) {
            rerun = true
          }
        })
      }

      if (rerun) {
        files.push(filepath)
      }
    }

    return Array.from(new Set(files))
  }

  private async reportCoverage(coverage: unknown, allTestsRun: boolean) {
    if (!this.config.coverage.reportOnFailure && this.state.getCountOfFailedTests() > 0) {
      return
    }

    if (this.coverageProvider) {
      await this.coverageProvider.reportCoverage(coverage, { allTestsRun })
      // notify coverage iframe reload
      for (const reporter of this.reporters) {
        if (reporter instanceof WebSocketReporter) {
          reporter.onFinishedReportCoverage()
        }
      }
    }
  }

  async close() {
    if (!this.closingPromise) {
      this.closingPromise = (async () => {
        const teardownProjects = [...this.projects]
        if (!teardownProjects.includes(this.coreWorkspaceProject)) {
          teardownProjects.push(this.coreWorkspaceProject)
        }
        // do teardown before closing the server
        for await (const project of teardownProjects.reverse()) {
          await project.teardownGlobalSetup()
        }

        const closePromises: unknown[] = this.resolvedProjects.map(w => w.close().then(() => w.server = undefined as any))
        // close the core workspace server only once
        // it's possible that it's not initialized at all because it's not running any tests
        if (!this.resolvedProjects.includes(this.coreWorkspaceProject)) {
          closePromises.push(this.coreWorkspaceProject.close().then(() => this.server = undefined as any))
        }

        if (this.pool) {
          closePromises.push((async () => {
            await this.pool?.close?.()

            this.pool = undefined
          })())
        }

        closePromises.push(...this._onClose.map(fn => fn()))

        return Promise.allSettled(closePromises).then((results) => {
          results.filter(r => r.status === 'rejected').forEach((err) => {
            this.logger.error('error during close', (err as PromiseRejectedResult).reason)
          })
          this.logger.logUpdate.done() // restore terminal cursor
        })
      })()
    }
    return this.closingPromise
  }

  /**
   * Close the thread pool and exit the process
   */
  async exit(force = false) {
    setTimeout(() => {
      this.report('onProcessTimeout').then(() => {
        console.warn(`close timed out after ${this.config.teardownTimeout}ms`)
        this.state.getProcessTimeoutCauses().forEach(cause => console.warn(cause))

        if (!this.pool) {
          const runningServers = [this.server, ...this.resolvedProjects.map(p => p.server)].filter(Boolean).length

          if (runningServers === 1) {
            console.warn('Tests closed successfully but something prevents Vite server from exiting')
          }
          else if (runningServers > 1) {
            console.warn(`Tests closed successfully but something prevents ${runningServers} Vite servers from exiting`)
          }
          else { console.warn('Tests closed successfully but something prevents the main process from exiting') }

          console.warn('You can try to identify the cause by enabling "hanging-process" reporter. See https://vitest.dev/config/#reporters')
        }

        process.exit()
      })
    }, this.config.teardownTimeout).unref()

    await this.close()
    if (force) {
      process.exit()
    }
  }

  async report<T extends keyof Reporter>(name: T, ...args: ArgumentsType<Reporter[T]>) {
    await Promise.all(this.reporters.map(r => r[name]?.(
      // @ts-expect-error let me go
      ...args,
    )))
  }

  public async getTestFilepaths() {
    return this.globTestFiles().then(files => files.map(([, file]) => file))
  }

  public async globTestFiles(filters: string[] = []) {
    const files: WorkspaceSpec[] = []
    await Promise.all(this.projects.map(async (project) => {
      const specs = await project.globTestFiles(filters)
      specs.forEach((file) => {
        files.push([project, file])
        const projects = this.projectsTestFiles.get(file) || new Set()
        projects.add(project)
        this.projectsTestFiles.set(file, projects)
      })
    }))
    return files
  }

  // The server needs to be running for communication
  shouldKeepServer() {
    return !!this.config?.watch
  }

  onServerRestart(fn: OnServerRestartHandler) {
    this._onRestartListeners.push(fn)
  }

  onAfterSetServer(fn: OnServerRestartHandler) {
    this._onSetServer.push(fn)
  }

  onCancel(fn: (reason: CancelReason) => void) {
    this._onCancelListeners.push(fn)
  }

  onClose(fn: () => void) {
    this._onClose.push(fn)
  }
}
