import mapSeries from 'p-map-series';
import { Graph, Node, Edge } from '@teambit/graph.cleargraph';
import { flatten, partition } from 'lodash';
import type { Consumer } from '@teambit/legacy.consumer';
import type { Component, ComponentID } from '@teambit/component';
import { ConsumerComponent } from '@teambit/legacy.consumer-component';
import { ComponentIdList } from '@teambit/component-id';
import type { ComponentDependency, DependencyResolverMain } from '@teambit/dependency-resolver';
import type { CompIdGraph, DepEdgeType } from '@teambit/graph';
import { ComponentNotFound, ScopeNotFound } from '@teambit/legacy.scope';
import { ComponentNotFound as ComponentNotFoundInScope } from '@teambit/scope';
import compact from 'lodash.compact';
import type { Logger } from '@teambit/logger';
import { BitError } from '@teambit/bit-error';
import type { Workspace } from './workspace';

export function lifecycleToDepType(compDep: ComponentDependency): DepEdgeType {
  if (compDep.isExtension) return 'ext';
  switch (compDep.lifecycle) {
    case 'dev':
      return 'dev';
    case 'runtime':
      return 'prod';
    case 'peer':
      return 'peer';
    default:
      throw new Error(`lifecycle ${compDep.lifecycle} is not support`);
  }
}

export class GraphIdsFromFsBuilder {
  private graph = new Graph<ComponentID, DepEdgeType>();
  private completed: string[] = [];
  private depth = 1;
  private consumer: Consumer;
  private loadedComponents: { [idStr: string]: Component } = {};
  private importedIds: string[] = [];
  private shouldThrowOnInvalidDeps = true; // for now it has the same value as shouldThrowOnMissingDep. change if needed
  constructor(
    private workspace: Workspace,
    private logger: Logger,
    private dependencyResolver: DependencyResolverMain,
    private shouldThrowOnMissingDep = true
  ) {
    this.consumer = this.workspace.consumer;
    this.shouldThrowOnInvalidDeps = this.shouldThrowOnMissingDep;
  }

  /**
   * create a graph with all dependencies and flattened dependencies of the given components.
   * the nodes are component-ids and the edges has a label of the dependency type.
   * to get some info about this the graph build take a look into build-graph-from-fs.buildGraph() docs.
   */
  async buildGraph(ids: ComponentID[]): Promise<Graph<ComponentID, DepEdgeType>> {
    this.logger.debug(`GraphIdsFromFsBuilder, buildGraph with ${ids.length} seeders`);
    const start = Date.now();
    const components = await this.loadManyComponents(ids);
    await this.processManyComponents(components);
    this.logger.debug(
      `GraphIdsFromFsBuilder, buildGraph with ${ids.length} seeders completed (${(Date.now() - start) / 1000} sec)`
    );
    return this.graph;
  }

  private async processManyComponents(components: Component[]) {
    this.logger.debug(
      `GraphIdsFromFsBuilder.processManyComponents depth ${this.depth}, ${components.length} components`
    );
    this.depth += 1;
    await this.importObjects(components);
    const allDependencies = await mapSeries(components, (component) => this.processOneComponent(component));
    const allDependenciesFlattened = flatten(allDependencies);
    if (allDependenciesFlattened.length) await this.processManyComponents(allDependenciesFlattened);
  }

  /**
   * only for components from the workspace that can be modified to add/remove dependencies, we need to make sure that
   * all their dependencies are imported.
   * once a component from scope is imported, we know that either we have its dependency graph or all flattened deps
   */
  private async importObjects(components: Component[]) {
    const workspaceIds = this.workspace.listIds();
    const compOnWorkspaceOnly = components.filter((comp) => workspaceIds.find((id) => id.isEqual(comp.id)));
    const notImported = compOnWorkspaceOnly.map((c) => c.id).filter((id) => !this.importedIds.includes(id.toString()));
    const exportedDeps = notImported.filter((dep) => this.workspace.isExported(dep));
    const scopeComponentsImporter = this.consumer.scope.scopeImporter;
    await scopeComponentsImporter.importMany({
      ids: ComponentIdList.uniqFromArray(exportedDeps),
      throwForDependencyNotFound: this.shouldThrowOnMissingDep,
      throwForSeederNotFound: this.shouldThrowOnMissingDep,
      reFetchUnBuiltVersion: false,
      lane: await this.workspace.getCurrentLaneObject(),
      reason: 'for building graph-ids from the workspace',
    });
    notImported.map((id) => this.importedIds.push(id.toString()));
  }

  private async processOneComponent(component: Component) {
    const idStr = component.id.toString();
    if (this.completed.includes(idStr)) return [];
    const graphFromScope = await this.workspace.getSavedGraphOfComponentIfExist(component);
    if (graphFromScope?.edges.length) {
      const isOnWorkspace = await this.workspace.hasId(component.id);
      if (isOnWorkspace) {
        const allDependenciesComps = await this.processCompFromWorkspaceWithGraph(graphFromScope, component);
        this.completed.push(idStr);
        return allDependenciesComps;
      }
      this.graph.merge([graphFromScope]);
      this.completed.push(idStr);
      return [];
    }

    const deps = this.dependencyResolver.getComponentDependencies(component);
    const allDepsIds = deps.map((d) => d.componentId);
    const allDependenciesComps = await this.loadManyComponents(allDepsIds, idStr);

    deps.forEach((dep) => this.addDepEdge(idStr, dep));
    this.completed.push(idStr);

    return allDependenciesComps;
  }

  /**
   * this is tricky.
   * the component is in the workspace so it can be modified. dependencies can be added/removed/updated/downgraded.
   * we have the graph-dependencies from the last snap, so we prefer to use it whenever possible for performance reasons.
   * if we can't use it, we have to recursively load dependencies components and get the data from there.
   * to maximize the performance, we iterate the direct dependencies, if we find a dep with the same id in the graph,
   * and that id is not in the workspace then ask the graph for all its successors. otherwise, if it's not there, or
   * it's there but it's also in the workspace (which therefore can be modified), we recursively load the dep components
   * and get its dependencies.
   */
  private async processCompFromWorkspaceWithGraph(
    graphFromScope: CompIdGraph,
    component: Component
  ): Promise<Component[]> {
    const deps = this.dependencyResolver.getComponentDependencies(component);
    const workspaceIds = this.workspace.listIds();
    const workspaceIdsStr = workspaceIds.map((id) => id.toString());
    const [depsInScopeGraph, depsNotInScopeGraph] = partition(
      deps,
      (dep) =>
        graphFromScope.hasNode(dep.componentId.toString()) && !workspaceIdsStr.includes(dep.componentId.toString())
    );

    const depsInScopeGraphIds = depsInScopeGraph.map((dep) => dep.componentId.toString());
    const depsInScopeGraphIdsNotCompleted = depsInScopeGraphIds.filter((id) => !this.completed.includes(id));
    if (depsInScopeGraphIdsNotCompleted.length) {
      const subGraphs = graphFromScope.successorsSubgraph(depsInScopeGraphIdsNotCompleted);
      // delete any edge that its source is from the workspace. if this component is modified, this edge could be
      // incorrect. we don't need these edges anyway because we add them directly.
      subGraphs.edges.forEach((edge) => {
        if (workspaceIdsStr.includes(edge.sourceId)) subGraphs.deleteEdge(edge.sourceId, edge.targetId);
      });
      this.graph.merge([subGraphs]);
      this.completed.push(...depsInScopeGraphIdsNotCompleted);
    }

    const allDepsIds = depsNotInScopeGraph.map((d) => d.componentId);
    const idStr = component.id.toString();
    const allDependenciesComps = await this.loadManyComponents(allDepsIds, idStr);
    deps.forEach((dep) => this.addDepEdge(idStr, dep));
    return allDependenciesComps;
  }

  private addDepEdge(idStr: string, dep: ComponentDependency) {
    const depId = dep.componentId;
    if (!this.graph.hasNode(depId.toString())) {
      if (this.shouldThrowOnMissingDep) {
        throw new Error(`buildOneComponent: missing node of ${depId.toString()}`);
      }
      this.logger.warn(`ignoring missing ${depId.toString()}`);
      return;
    }
    this.graph.setEdge(new Edge(idStr, depId.toString(), lifecycleToDepType(dep)));
  }

  private async loadManyComponents(componentsIds: ComponentID[], dependenciesOf?: string): Promise<Component[]> {
    const components = await mapSeries(componentsIds, async (compId) => {
      const idStrPotentiallyWithoutVersion = compId.toString();
      const fromCache = this.loadedComponents[idStrPotentiallyWithoutVersion];
      if (fromCache) return fromCache;
      try {
        const component = await this.workspace.get(compId);
        const idStr = component.id.toString();
        this.loadedComponents[idStr] = component;
        this.graph.setNode(new Node(idStr, component.id));
        return component;
      } catch (err: any) {
        if (
          err instanceof ComponentNotFound ||
          err instanceof ComponentNotFoundInScope ||
          err instanceof ScopeNotFound
        ) {
          if (dependenciesOf && !this.shouldThrowOnMissingDep) {
            this.logger.warn(
              `component ${idStrPotentiallyWithoutVersion}, dependency of ${dependenciesOf} was not found. continuing without it`
            );
            return null;
          }
          throw new BitError(
            `error: component "${idStrPotentiallyWithoutVersion}" was not found.\nthis component is a dependency of "${
              dependenciesOf || '<none>'
            }" and is needed as part of the graph generation`
          );
        }
        if (ConsumerComponent.isComponentInvalidByErrorType(err)) {
          if (dependenciesOf && !this.shouldThrowOnInvalidDeps) {
            this.logger.warn(
              `component ${idStrPotentiallyWithoutVersion}, dependency of ${dependenciesOf} is invalid. continuing without it`
            );
            return null;
          }
          throw new BitError(
            `error: component "${idStrPotentiallyWithoutVersion}" is invalid (${err.message}).\nthis component is a dependency of "${
              dependenciesOf || '<none>'
            }" and is needed as part of the graph generation`
          );
        }
        if (dependenciesOf) this.logger.error(`failed loading dependencies of ${dependenciesOf}`);
        throw err;
      }
    });
    return compact(components);
  }
}
