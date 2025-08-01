import * as path from 'path';
import fs from 'fs-extra';
import type { AspectLoaderMain } from '@teambit/aspect-loader';
import { AspectLoaderAspect } from '@teambit/aspect-loader';
import type { BuilderMain } from '@teambit/builder';
import { BuilderAspect } from '@teambit/builder';
import type { CLIMain } from '@teambit/cli';
import { CLIAspect, MainRuntime } from '@teambit/cli';
import { IssuesClasses } from '@teambit/component-issues';
import type { IssuesMain } from '@teambit/issues';
import { IssuesAspect } from '@teambit/issues';
import type { Component } from '@teambit/component';
import { DEFAULT_DIST_DIRNAME } from '@teambit/legacy.constants';
import type { WatcherMain } from '@teambit/watcher';
import { WatcherAspect } from '@teambit/watcher';
import type { EnvsMain, ExecutionContext } from '@teambit/envs';
import { EnvsAspect } from '@teambit/envs';
import type { ComponentID } from '@teambit/component-id';
import type { DependencyResolverMain } from '@teambit/dependency-resolver';
import { DependencyResolverAspect } from '@teambit/dependency-resolver';
import type { LoggerMain } from '@teambit/logger';
import { LoggerAspect } from '@teambit/logger';
import type { GeneratorMain } from '@teambit/generator';
import { GeneratorAspect } from '@teambit/generator';
import type { PubsubMain } from '@teambit/pubsub';
import { PubsubAspect } from '@teambit/pubsub';
import type { UiMain } from '@teambit/ui';
import { UIAspect } from '@teambit/ui';
import type { Workspace, WorkspaceComponentLoadOptions } from '@teambit/workspace';
import { WorkspaceAspect } from '@teambit/workspace';
import type { BundlerMain } from '@teambit/bundler';
import { BundlerAspect } from '@teambit/bundler';
import { CompilerAspect } from './compiler.aspect';
import { CompileCmd } from './compiler.cmd';
import { CompilerService } from './compiler.service';
import { CompilerTask } from './compiler.task';
import { DistArtifact } from './dist-artifact';
import { DistArtifactNotFound } from './exceptions';
import type { Compiler } from './types';
import { CompilationInitiator } from './types';
import type { CompileOptions } from './workspace-compiler';
import { WorkspaceCompiler } from './workspace-compiler';
import { compilerTemplate } from './templates/compiler';

export class CompilerMain {
  constructor(
    private pubsub: PubsubMain,
    private workspaceCompiler: WorkspaceCompiler,
    private envs: EnvsMain,
    private builder: BuilderMain,
    private workspace: Workspace,
    private dependencyResolver: DependencyResolverMain,
    private compilerService: CompilerService
  ) {}

  getCompiler(context: ExecutionContext): Compiler | undefined {
    return this.compilerService.getCompiler(context);
  }

  /**
   * Run compilation on `bit new` and when new components are imported
   */
  compileOnWorkspace(
    componentsIds: string[] | ComponentID[] | ComponentID[] = [], // when empty, it compiles all
    options: CompileOptions = { initiator: CompilationInitiator.ComponentAdded },
    noThrow?: boolean,
    componentLoadOptions: WorkspaceComponentLoadOptions = {}
  ) {
    return this.workspaceCompiler.compileComponents(componentsIds, options, noThrow, componentLoadOptions);
  }
  /**
   * API to create a new compiler task, it facilitates the usage of multiple compilers.
   * with this method you can create any number of compilers and add them to the buildPipeline.
   */
  createTask(name: string, compiler: Compiler): CompilerTask {
    return new CompilerTask(CompilerAspect.id, name, compiler, this.dependencyResolver);
  }

  /**
   * find the compiler configured on the workspace and ask for the dist path.
   */
  getDistPathBySrcPath(component: Component, srcPath: string): string | null {
    const environment = this.envs.getEnv(component).env;
    const compilerInstance = environment.getCompiler?.();
    if (!compilerInstance) return null;
    return compilerInstance.getDistPathBySrcPath(srcPath);
  }

  /**
   * find the compiler configured on the workspace and ask for the dist folder path.
   */
  getRelativeDistFolder(component: Component): string {
    const environment = this.envs.getOrCalculateEnv(component).env;
    const compilerInstance: Compiler | undefined = environment.getCompiler?.();
    if (!compilerInstance || !compilerInstance.getDistDir) return DEFAULT_DIST_DIRNAME;
    return compilerInstance.getDistDir();
  }

  /**
   * Check if the dist folder (in the component package under node_modules) exist
   * @param component
   * @returns
   */
  async isDistDirExists(component: Component): Promise<boolean> {
    const packageDir = await this.workspace.getComponentPackagePath(component);
    const distDir = this.getRelativeDistFolder(component);
    const pathToCheck = path.join(packageDir, distDir);
    return fs.existsSync(pathToCheck);
  }

  async getDistsFiles(component: Component): Promise<DistArtifact> {
    const artifacts = await this.builder.getArtifactsVinylByAspect(component, CompilerAspect.id);
    if (!artifacts.length) throw new DistArtifactNotFound(component.id);

    return new DistArtifact(artifacts);
  }

  async addMissingDistsIssue(components: Component[], issuesToIgnore: string[]): Promise<void> {
    if (issuesToIgnore.includes(IssuesClasses.MissingDists.name)) return;
    await Promise.all(
      components.map(async (component) => {
        const exist = await this.isDistDirExists(component);
        if (!exist) {
          component.state.issues.getOrCreate(IssuesClasses.MissingDists).data = true;
        }
      })
    );
  }

  static runtime = MainRuntime;

  static dependencies = [
    CLIAspect,
    WorkspaceAspect,
    EnvsAspect,
    LoggerAspect,
    PubsubAspect,
    AspectLoaderAspect,
    BuilderAspect,
    UIAspect,
    GeneratorAspect,
    DependencyResolverAspect,
    WatcherAspect,
    IssuesAspect,
    BundlerAspect,
  ];

  static async provider([
    cli,
    workspace,
    envs,
    loggerMain,
    pubsub,
    aspectLoader,
    builder,
    ui,
    generator,
    dependencyResolver,
    watcher,
    issues,
    bundler,
  ]: [
    CLIMain,
    Workspace,
    EnvsMain,
    LoggerMain,
    PubsubMain,
    AspectLoaderMain,
    BuilderMain,
    UiMain,
    GeneratorMain,
    DependencyResolverMain,
    WatcherMain,
    IssuesMain,
    BundlerMain,
  ]) {
    const logger = loggerMain.createLogger(CompilerAspect.id);
    const compilerService = new CompilerService();

    const workspaceCompiler = new WorkspaceCompiler(
      workspace,
      envs,
      pubsub,
      aspectLoader,
      ui,
      logger,
      dependencyResolver,
      watcher
    );
    envs.registerService(compilerService);
    const compilerMain = new CompilerMain(
      pubsub,
      workspaceCompiler,
      envs,
      builder,
      workspace,
      dependencyResolver,
      compilerService
    );
    cli.register(new CompileCmd(workspaceCompiler, logger, pubsub));
    if (issues) {
      issues.registerAddComponentsIssues(compilerMain.addMissingDistsIssue.bind(compilerMain));
    }
    if (generator) generator.registerComponentTemplate([compilerTemplate]);

    bundler.registerOnPreDevServerCreated(async (newCompsWithoutDevServer) => {
      logger.debug(
        `Compiling ${newCompsWithoutDevServer.length} components: ${newCompsWithoutDevServer.map((c) => c.id.toString()).join(', ')} before dev server creation`
      );
      await compilerMain.compileOnWorkspace(
        newCompsWithoutDevServer.map((c) => c.id),
        { initiator: CompilationInitiator.PreDevServer }
      );
    });

    return compilerMain;
  }
}

CompilerAspect.addRuntime(CompilerMain);

export default CompilerMain;
