import { uniqWith } from 'lodash';
import { sortObjectByKeys } from '@teambit/toolbox.object.sorter';
import { snapToSemver } from '@teambit/component-package-version';
import type { Policy, SemverVersion, GitUrlVersion, FileSystemPath, PolicyConfigKeys } from '../policy';
import type { WorkspaceDependencyLifecycleType } from '../../dependencies';
import { KEY_NAME_BY_LIFECYCLE_TYPE } from '../../dependencies';
import { EntryAlreadyExist } from './exceptions';

export type WorkspacePolicyConfigKeys = Omit<PolicyConfigKeys, 'devDependencies'>;
export type WorkspacePolicyConfigKeysNames = keyof WorkspacePolicyConfigKeys;

export type WorkspacePolicyConfigObject = Partial<
  Record<WorkspacePolicyConfigKeysNames, WorkspacePolicyLifecycleConfigObject>
>;
export type WorkspacePolicyManifest = Partial<
  Record<WorkspacePolicyConfigKeysNames, WorkspacePolicyLifecycleManifestObject>
>;

export type WorkspacePolicyLifecycleConfigObject = {
  [dependencyId: string]: WorkspacePolicyConfigEntryValue;
};

type WorkspacePolicyLifecycleManifestObject = {
  [dependencyId: string]: WorkspacePolicyEntryVersion;
};

export type WorkspacePolicyConfigEntryValue = WorkspacePolicyEntryValue | WorkspacePolicyEntryVersion;

export type AddEntryOptions = {
  updateExisting?: boolean;
  skipIfExisting?: boolean;
};
/**
 * Allowed values are valid semver values, git urls, fs path.
 */
export type WorkspacePolicyEntryVersion = SemverVersion | GitUrlVersion | FileSystemPath;

export type WorkspacePolicyEntryValue = {
  version: WorkspacePolicyEntryVersion;
  preserve?: boolean;
};

export type WorkspacePolicyEntry = {
  dependencyId: string;
  lifecycleType: WorkspaceDependencyLifecycleType;
  value: WorkspacePolicyEntryValue;
};

export class WorkspacePolicy implements Policy<WorkspacePolicyConfigObject> {
  constructor(private _policiesEntries: WorkspacePolicyEntry[]) {
    this._policiesEntries = uniqEntries(_policiesEntries);
  }

  get entries() {
    return this._policiesEntries;
  }

  add(entry: WorkspacePolicyEntry, options?: AddEntryOptions): void {
    const defaultOptions: AddEntryOptions = {
      updateExisting: false,
      skipIfExisting: false,
    };

    const calculatedOpts = Object.assign({}, defaultOptions, options);

    const existing = this.find(entry.dependencyId);
    if (existing) {
      if (calculatedOpts.skipIfExisting) {
        return;
      }
      if (!calculatedOpts.updateExisting) {
        throw new EntryAlreadyExist(entry);
      }
      this.remove([entry.dependencyId]);
    }
    this._policiesEntries.push(entry);
  }

  forEach(predicate: (dep: WorkspacePolicyEntry, index?: number) => void): void {
    this.entries.forEach(predicate);
  }

  filter(predicate: (dep: WorkspacePolicyEntry, index?: number) => boolean): WorkspacePolicy {
    const filtered = this.entries.filter(predicate);
    return new WorkspacePolicy(filtered);
  }

  find(depId: string, lifecycleType?: WorkspaceDependencyLifecycleType): WorkspacePolicyEntry | undefined {
    const matchedEntry = this.entries.find((entry) => {
      const idEqual = entry.dependencyId === depId;
      const lifecycleEqual = lifecycleType ? entry.lifecycleType === lifecycleType : true;
      return idEqual && lifecycleEqual;
    });
    return matchedEntry;
  }

  remove(depIds: string[]): WorkspacePolicy {
    const entries = this.entries.filter((entry) => {
      return !depIds.includes(entry.dependencyId);
    });
    return new WorkspacePolicy(entries);
  }

  getDepVersion(
    depId: string,
    lifecycleType?: WorkspaceDependencyLifecycleType
  ): WorkspacePolicyEntryVersion | undefined {
    const entry = this.find(depId, lifecycleType);
    if (!entry) {
      return undefined;
    }
    return entry.value.version;
  }

  getValidSemverDepVersion(
    depId: string,
    lifecycleType?: WorkspaceDependencyLifecycleType
  ): WorkspacePolicyEntryVersion | undefined {
    const version = this.getDepVersion(depId, lifecycleType);
    if (!version) return undefined;
    return snapToSemver(version);
  }

  toConfigObject(): WorkspacePolicyConfigObject {
    const res: WorkspacePolicyConfigObject = {
      dependencies: {},
      peerDependencies: {},
    };
    this._policiesEntries.reduce((acc, entry) => {
      const keyName = KEY_NAME_BY_LIFECYCLE_TYPE[entry.lifecycleType];
      const value = entry.value.preserve ? entry.value : entry.value.version;
      acc[keyName][entry.dependencyId] = value;
      return acc;
    }, res);
    if (res.dependencies) {
      res.dependencies = sortObjectByKeys(res.dependencies);
    }
    if (res.peerDependencies) {
      res.peerDependencies = sortObjectByKeys(res.peerDependencies);
    }
    return res;
  }

  /**
   * Create an object ready for package manager installation
   * this is similar to "toConfigObject" but it will make the value of a specific dep always a string (the version / url)
   */
  toManifest(): WorkspacePolicyManifest {
    const res: WorkspacePolicyManifest = {
      dependencies: {},
      peerDependencies: {},
    };
    this._policiesEntries.reduce((acc, entry) => {
      const keyName = KEY_NAME_BY_LIFECYCLE_TYPE[entry.lifecycleType];
      acc[keyName][entry.dependencyId] = snapToSemver(entry.value.version);
      return acc;
    }, res);
    return res;
  }

  byLifecycleType(lifecycleType: WorkspaceDependencyLifecycleType): WorkspacePolicy {
    const filtered = this._policiesEntries.filter((entry) => entry.lifecycleType === lifecycleType);
    return new WorkspacePolicy(filtered);
  }

  static mergePolices(policies: WorkspacePolicy[]): WorkspacePolicy {
    let allEntries: WorkspacePolicyEntry[] = [];
    allEntries = policies.reduce((acc, curr) => {
      return acc.concat(curr.entries);
    }, allEntries);
    // We reverse it to make sure the latest policy will be stronger in case of conflict
    allEntries = allEntries.reverse();
    return new WorkspacePolicy(allEntries);
  }
}

function uniqEntries(entries: Array<WorkspacePolicyEntry>): Array<WorkspacePolicyEntry> {
  const uniq = uniqWith(entries, (entry1: WorkspacePolicyEntry, entry2: WorkspacePolicyEntry) => {
    return entry1.dependencyId === entry2.dependencyId && entry1.lifecycleType === entry2.lifecycleType;
  });
  return uniq;
}
