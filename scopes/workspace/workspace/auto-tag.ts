import graphlib, { Graph } from 'graphlib';
import semver from 'semver';
import { ComponentIdList } from '@teambit/component-id';
import { isTag } from '@teambit/component-version';
import type { Consumer } from '@teambit/legacy.consumer';
import type { Dependency, ConsumerComponent as Component } from '@teambit/legacy.consumer-component';

export async function getAutoTagPending(consumer: Consumer, changedComponents: ComponentIdList): Promise<Component[]> {
  const autoTagInfo = await getAutoTagInfo(consumer, changedComponents);
  return autoTagInfo.map((a) => a.component);
}

export type AutoTagResult = { component: Component; triggeredBy: ComponentIdList };

export async function getAutoTagInfo(consumer: Consumer, changedComponents: ComponentIdList): Promise<AutoTagResult[]> {
  if (!changedComponents.length) return [];
  const potentialComponents = potentialComponentsForAutoTagging(consumer, changedComponents);
  const idsToLoad = new ComponentIdList(...potentialComponents, ...changedComponents);
  const { components } = await consumer.loadComponents(idsToLoad, false);
  const graph = buildGraph(components);

  const autoTagResults: AutoTagResult[] = [];
  components.forEach((component) => {
    const bitId = component.componentId;
    const idStr = bitId.toStringWithoutVersion();
    if (!graph.hasNode(idStr)) return;
    // preorder gets all dependencies and dependencies of dependencies and so on.
    // we loop over the dependencies of a component
    // @ts-ignore
    const dependenciesStr = graphlib.alg.preorder(graph, idStr);
    const dependenciesBitIds = dependenciesStr.map((depStr) => graph.node(depStr));
    const triggeredDependencies = dependenciesBitIds.filter((dependencyId) => {
      const changedComponentId = changedComponents.searchWithoutVersion(dependencyId);
      if (!changedComponentId) {
        // the dependency hasn't changed, so the component is not auto-tag pending
        return false;
      }
      if (changedComponents.searchWithoutVersion(bitId)) {
        // the dependency has changed but also the component itself, so it's going to be tagged anyway
        return false;
      }
      // we only check whether a modified component may cause auto-tagging
      // since it's only modified on the file-system, its version might be the same as the version stored in its
      // dependents. That's why "semver.gte" is used instead of "semver.gt".
      // the case when it returns false is when the changedComponentId.version is smaller than
      // edgeId.version. it happens for example, when A => B (A depends on B), B has changed, A is
      // a candidate. A has the B dependency saved in the model with version 2.0.0 and B is now
      // tagged with 1.0.1. So, because A has B with a higher version already, we don't want to
      // auto-tag it and downgrade its B version.
      if (isTag(changedComponentId.version) && isTag(dependencyId.version)) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return semver.gte(changedComponentId.version!, dependencyId.version!);
      }
      // when they're not tags but snaps, it is impossible to snap from a detached head so a
      // component is always candidate when its dependencies have changed.
      return true;
    });
    if (triggeredDependencies.length) {
      autoTagResults.push({ component, triggeredBy: ComponentIdList.fromArray(triggeredDependencies) });
    }
  });

  return autoTagResults;
}

function buildGraph(components: Component[]): Graph {
  const graph = new Graph();
  const componentsIds = ComponentIdList.fromArray(components.map((c) => c.id));

  components.forEach((component) => {
    const idStr = component.id.toStringWithoutVersion();
    component.getAllDependencies().forEach((dependency: Dependency) => {
      if (componentsIds.searchWithoutVersion(dependency.id)) {
        const depId = dependency.id.toStringWithoutVersion();
        // save the full ComponentID of a string id to be able to retrieve it later with no confusion
        if (!graph.hasNode(idStr)) graph.setNode(idStr, component.id);
        if (!graph.hasNode(depId)) graph.setNode(depId, dependency.id);
        graph.setEdge(idStr, depId);
      }
    });
  });
  return graph;
}

function potentialComponentsForAutoTagging(consumer: Consumer, modifiedComponents: ComponentIdList): ComponentIdList {
  const candidateComponentsIds = consumer.bitMap.getAllBitIds();
  // if a modified component is in candidates array, remove it from the array as it will be already
  // tagged with the correct version
  const idsWithoutModified = candidateComponentsIds.filter(
    (candidateId) => !modifiedComponents.hasWithoutVersion(candidateId)
  );
  return ComponentIdList.fromArray(idsWithoutModified);
}
