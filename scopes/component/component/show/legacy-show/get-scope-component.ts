import { ComponentID } from '@teambit/component-id';
import { loader } from '@teambit/legacy.loader';
import type { Consumer } from '@teambit/legacy.consumer';
import { loadConsumerIfExist } from '@teambit/legacy.consumer';
import type { ConsumerComponent as Component } from '@teambit/legacy.consumer-component';
import { getRemoteByName } from '@teambit/scope.remotes';
import type { Scope } from '@teambit/legacy.scope';
import { loadScope } from '@teambit/legacy.scope';
import type { DependenciesInfo } from '@teambit/legacy.dependency-graph';

export async function getScopeComponent({
  id,
  scopePath,
  showDependents,
  showDependencies,
  loadScopeFromCache,
}: {
  id: string;
  scopePath?: string | null; // used by the api (see /src/api.js)
  showDependents?: boolean;
  showDependencies?: boolean;
  loadScopeFromCache?: boolean;
}): Promise<{ component: Component[] | Component }> {
  const bitId = ComponentID.fromString(id); // user used --remote so we know it has a scope

  if (scopePath) {
    // coming from the api
    const scope: Scope = await loadScope(scopePath, loadScopeFromCache);
    const component = await showComponentUsingScope(scope);
    return { component };
  }

  const consumer: Consumer | undefined = await loadConsumerIfExist();
  const remote = await getRemoteByName(bitId.scope, consumer);
  loader.start('showing a component...');
  const component = await remote.show(bitId);
  let dependenciesInfo: DependenciesInfo[] = [];
  let dependentsInfo: DependenciesInfo[] = [];
  if (showDependents || showDependencies) {
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    const componentDepGraph = await remote.graph(component.id);
    if (showDependents) {
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      dependentsInfo = componentDepGraph.getDependentsInfo(component.id);
    }
    if (showDependencies) {
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      dependenciesInfo = componentDepGraph.getDependenciesInfo(component.id);
    }
  }
  // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
  return { component, dependentsInfo, dependenciesInfo };

  async function showComponentUsingScope(scope: Scope) {
    const scopeComponentsImporter = scope.scopeImporter;
    return scopeComponentsImporter.loadRemoteComponent(bitId);
  }
}
