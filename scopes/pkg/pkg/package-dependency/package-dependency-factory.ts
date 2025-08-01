import type { DependencyLifecycleType, SerializedDependency, DependencyFactory } from '@teambit/dependency-resolver';
import { DependencyList } from '@teambit/dependency-resolver';
import type { ConsumerComponent as LegacyComponent } from '@teambit/legacy.consumer-component';
import type { SerializedPackageDependency } from './package-dependency';
import { PackageDependency } from './package-dependency';

const TYPE = 'package';
// TODO: think about where is the right place to put this
export class PackageDependencyFactory implements DependencyFactory {
  // parse<PackageDependency, SerializedDependency>(serialized: SerializedDependency): PackageDependency {
  //   return new PackageDependency(serialized.id, serialized.version, serialized.type, serialized.lifecycle as DependencyLifecycleType);
  // }
  type: string;

  constructor() {
    this.type = TYPE;
  }

  parse<PackageDependency, S extends SerializedDependency>(serialized: S): PackageDependency {
    // return new PackageDependency(serialized.id, serialized.version, serialized.type, serialized.lifecycle as DependencyLifecycleType) as unknown as PackageDependency;
    return new PackageDependency(
      serialized.id,
      serialized.version,
      serialized.lifecycle as DependencyLifecycleType,
      serialized.source,
      serialized.hidden,
      serialized.optional
    ) as unknown as PackageDependency;
  }

  async fromLegacyComponent(legacyComponent: LegacyComponent): Promise<DependencyList> {
    const runtimePackageDeps = transformLegacyComponentPackageDepsToSerializedDependency(
      legacyComponent.packageDependencies,
      'runtime'
    );
    const devPackageDeps = transformLegacyComponentPackageDepsToSerializedDependency(
      legacyComponent.devPackageDependencies,
      'dev'
    );
    const peerPackageDeps = transformLegacyComponentPackageDepsToSerializedDependency(
      legacyComponent.peerPackageDependencies,
      'peer'
    );

    const serializedPackageDeps = runtimePackageDeps.concat(devPackageDeps).concat(peerPackageDeps);
    const packageDepsP: Promise<PackageDependency>[] = serializedPackageDeps.map((dep) => this.parse(dep));
    const packageDeps: PackageDependency[] = await Promise.all(packageDepsP);
    const dependencyList = new DependencyList(packageDeps);
    return dependencyList;
  }

  // parse: <PackageDependency, SerializedDependency>(serialized: SerializedDependency) =>  {
  //   return new PackageDependency(serialized.id, serialized.version, serialized.type, serialized.lifecycle as DependencyLifecycleType);
  // }
}

function transformLegacyComponentPackageDepsToSerializedDependency(
  packageDepObj: Record<string, string>,
  lifecycle: DependencyLifecycleType
): SerializedPackageDependency[] {
  const res = Object.entries(packageDepObj).map(([packageName, version]) => {
    return {
      id: packageName,
      version,
      __type: TYPE,
      lifecycle,
    };
  });
  return res;
}
