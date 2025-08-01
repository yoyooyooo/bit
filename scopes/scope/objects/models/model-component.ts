import { forEach, isEmpty, pickBy, mapValues, isEqual, clone } from 'lodash';
import { Mutex } from 'async-mutex';
import * as semver from 'semver';
import { versionParser, isHash, isTag, isSnap, LATEST_VERSION } from '@teambit/component-version';
import { BitError } from '@teambit/bit-error';
import { LaneId, DEFAULT_LANE } from '@teambit/lane-id';
import { ComponentID, ComponentIdList } from '@teambit/component-id';
import pMapSeries from 'p-map-series';
import type { LegacyComponentLog } from '@teambit/legacy-component-log';
import { findDuplications } from '@teambit/toolbox.array.duplications-finder';
import { BitId } from '@teambit/legacy-bit-id';
import { DEFAULT_BIT_RELEASE_TYPE, DEFAULT_BIT_VERSION, DEFAULT_LANGUAGE, Extensions } from '@teambit/legacy.constants';
import type { Dependencies, Dependency } from '@teambit/legacy.consumer-component';
import { ConsumerComponent, SchemaName } from '@teambit/legacy.consumer-component';
import { License, SourceFile, getRefsFromExtensions } from '@teambit/component.sources';
import { ComponentOverrides, getBindingPrefixByDefaultScope } from '@teambit/legacy.consumer-config';
import { ValidationError } from '@teambit/legacy.cli.error';
import { logger } from '@teambit/legacy.logger';
import { getStringifyArgs } from '@teambit/legacy.utils';
import { getLatestVersion, validateVersion } from '@teambit/pkg.modules.semver-helper';
import type { SnapsDistance } from '@teambit/component.snap-distance';
import {
  getDivergeData,
  getAllVersionParents,
  getAllVersionsInfo,
  getVersionParentsFromVersion,
} from '@teambit/component.snap-distance';
import {
  ComponentObjects,
  ComponentVersion,
  HeadNotFound,
  ParentNotFound,
  VersionAlreadyExists,
  VersionNotFound,
  VersionNotFoundOnFS,
  NoHeadNoVersion,
  errorIsTypeOfMissingObject,
  BitIdCompIdError,
} from '@teambit/legacy.scope';
import type { Repository } from '../objects';
import { BitObject, Ref } from '../objects';
import type Lane from './lane';
import ScopeMeta from './scopeMeta';
import type Source from './source';
import type Version from './version';
import type { VersionParents } from './version-history';
import VersionHistory from './version-history';
import type { ObjectItem } from '../objects/object-list';
import type { Scope } from '@teambit/legacy.scope';
import type { ExtensionDataList } from '@teambit/legacy.extension-data';
import { DetachedHeads } from './detach-heads';

type State = {
  versions?: {
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    [version: string]: {
      local?: boolean; // whether a component was changed locally
    };
  };
};

export type AddVersionOpts = {
  addToUpdateDependentsInLane?: boolean;

  /**
   * kind of rebase.
   * if true, set the head as the parent of the new version.
   * by default, the parent is the currently used version in .bitmap.
   * (this prop takes affect only when the component is checked out to an older version)
   */
  setHeadAsParent?: boolean;

  detachHead?: boolean;
  overrideHead?: boolean;
};

type Versions = { [version: string]: Ref };
export type ScopeListItem = { url: string; name: string; date: string };

export type ComponentLog = LegacyComponentLog;

export type ComponentProps = {
  scope: string;
  name: string;
  versions?: Versions;
  orphanedVersions?: Versions;
  lang: string;
  deprecated: boolean;
  bindingPrefix: string;
  state?: State; // get deleted after export
  scopesList?: ScopeListItem[];
  head?: Ref;
  schema?: string | undefined;
  detachedHeads?: DetachedHeads;
};

export const VERSION_ZERO = '0.0.0';

/**
 * we can't rename the class as ModelComponent because old components are already saved in the model
 * with 'Component' in their headers. see object-registrar.types()
 */
// TODO: FIX me .parser
// @ts-ignore
export default class Component extends BitObject {
  scope: string;
  name: string;
  versions: Versions;
  orphanedVersions: Versions;
  lang: string;
  /**
   * @deprecated moved to the Version object inside teambit/deprecation aspect
   */
  deprecated: boolean;
  bindingPrefix: string;
  /**
   * @deprecated since 0.12.6 (long long ago :) probably can be removed)
   */
  local: boolean | null | undefined;
  state: State;
  scopesList: ScopeListItem[];
  head?: Ref;
  remoteHead?: Ref | null; // doesn't get saved in the scope, used to easier access the remote main head
  /**
   * doesn't get saved in the scope, used to easier access the local snap head data
   * when checked out to a lane, this prop is either Ref or null. otherwise (when on main), this prop is undefined.
   */
  laneHeadLocal?: Ref | null;
  /**
   * doesn't get saved in the scope, used to easier access the remote snap head data
   * when checked out to a lane, this prop is either Ref or null. otherwise (when on main), this prop is undefined.
   */
  laneHeadRemote?: Ref | null;

  /**
   * when checked out to a lane, calculate what should be the head on the remote.
   * if the laneHeadRemote is null, for example, when the lane is new, then used the the lane it was forked from.
   * it no head is found on the lane/forked, then use the component.head.
   */
  calculatedRemoteHeadWhenOnLane?: Ref | null;

  laneId?: LaneId; // doesn't get saved in the scope.
  laneDataIsPopulated = false; // doesn't get saved in the scope, used to improve performance of loading the lane data
  schema: string | undefined;
  detachedHeads: DetachedHeads;
  private divergeData?: SnapsDistance;
  private _populateVersionHistoryMutex?: Mutex;
  constructor(props: ComponentProps) {
    super();
    if (!props.name) throw new TypeError('Model Component constructor expects to get a name parameter');
    if (!props.scope) {
      throw new BitIdCompIdError(props.name);
    }
    this.scope = props.scope;
    this.name = props.name;
    this.versions = props.versions || {};
    this.orphanedVersions = props.orphanedVersions || {};
    this.lang = props.lang || DEFAULT_LANGUAGE;
    this.deprecated = props.deprecated || false;
    this.bindingPrefix = props.bindingPrefix || getBindingPrefixByDefaultScope(props.scope);
    this.state = props.state || {};
    this.scopesList = props.scopesList || [];
    this.head = props.head;
    this.schema = props.schema;
    this.detachedHeads = props.detachedHeads || new DetachedHeads();
  }

  private get populateVersionHistoryMutex() {
    if (!this._populateVersionHistoryMutex) {
      this._populateVersionHistoryMutex = new Mutex();
    }
    return this._populateVersionHistoryMutex;
  }

  get versionArray(): Ref[] {
    return Object.values(this.versions);
  }

  setVersion(tag: string, ref: Ref) {
    this.versions[tag] = ref;
    delete this.orphanedVersions[tag]; // just in case it's there.
  }

  setOrphanedVersion(tag: string, ref: Ref) {
    if (this.versions[tag]) {
      throw new Error(
        `unable to save orphanedVersion "${tag}" for "${this.id()}" because this tag is already part of the versions prop`
      );
    }
    this.orphanedVersions[tag] = ref;
  }

  getRef(version: string): Ref | null {
    if (isTag(version)) {
      return this.versionsIncludeOrphaned[version];
    }
    if (isHash(version)) {
      return new Ref(version);
    }
    return null;
  }

  getHeadStr(): string | null {
    return this.head ? this.head.toString() : null;
  }

  getHead(): Ref | undefined {
    return this.head;
  }

  /**
   * returns the head hash. regardless of whether current lane is the default or not.
   * if on a lane, it returns the head of the component on the lane.
   */
  getHeadRegardlessOfLane(): Ref | undefined {
    return this.laneHeadLocal || this.getHead();
  }

  getHeadAsTagIfExist(): string | undefined {
    if (!this.head) return undefined;
    return this.getTagOfRefIfExists(this.head) || this.head.toString();
  }

  hasHead() {
    return Boolean(this.head);
  }

  setHead(head: Ref | undefined) {
    this.head = head;
  }

  listVersions(sort?: 'ASC' | 'DESC'): string[] {
    const versions = Object.keys(this.versions);
    if (!sort) return versions;
    if (sort === 'ASC') {
      return versions.sort(semver.compare);
    }

    return versions.sort(semver.compare).reverse();
  }

  listVersionsIncludeOrphaned(sort?: 'ASC' | 'DESC'): string[] {
    const versions = Object.keys(this.versionsIncludeOrphaned);
    if (!sort) return versions;
    if (sort === 'ASC') {
      return versions.sort(semver.compare);
    }

    return versions.sort(semver.compare).reverse();
  }

  async hasVersion(version: string, repo: Repository, includeOrphaned = true): Promise<boolean> {
    if (isTag(version)) {
      return includeOrphaned ? this.hasTagIncludeOrphaned(version) : this.hasTag(version);
    }
    const head = this.getHeadRegardlessOfLane();
    if (!head) {
      return false;
    }
    const versionParents = await getAllVersionParents({ repo, modelComponent: this, heads: [head] });
    // we use "startsWith" because it can be a short hash
    return versionParents.map((v) => v.hash).some((hash) => hash.toString().startsWith(version));
  }

  hasTag(version: string): boolean {
    return Boolean(this.versions[version]);
  }

  get versionsIncludeOrphaned(): Versions {
    // for bit-bin with 266 components, it takes about 1,700ms. don't use lodash.merge, it's much faster
    // but mutates `this.versions`.
    return { ...this.versions, ...this.orphanedVersions };
  }

  hasTagIncludeOrphaned(version: string): boolean {
    return Boolean(this.versions[version] || this.orphanedVersions[version]);
  }

  /**
   * whether the head is a snap (not a tag)
   */
  isHeadSnap() {
    const tagsHashes = this.versionArray.map((ref) => ref.toString());
    return this.head && !tagsHashes.includes(this.head.toString());
  }

  /**
   * add a new remote if it is not there already
   */
  addScopeListItem(scopeListItem: ScopeListItem): void {
    if (!scopeListItem.name || !scopeListItem.url || !scopeListItem.date) {
      throw new TypeError(
        `model-component.addRemote get an invalid remote. name: ${scopeListItem.name}, url: ${scopeListItem.url}, date: ${scopeListItem.date}`
      );
    }
    if (!this.scopesList.find((r) => r.url === scopeListItem.url)) {
      this.scopesList.push(scopeListItem);
    }
  }

  /**
   * on main - it checks local-head (or .bitmap version if given) vs remote-head.
   * on lane - it checks local-head on lane vs remote-head on lane.
   * however, to get an accurate `divergeData.snapsOnSourceOnly`, the above is not enough.
   * for example, comp-a@snap-x from lane-a is merged into lane-b. we don't want this snap-x to be "local", because
   * then, bit-status will show it as "staged" and bit-reset will remove it unexpectedly.
   * if we only check by the local-head and remote-head on lane, it'll be local because the remote-head of lane-b is empty.
   * to address this, we search all remote-refs files for this bit-id and during the local history traversal, if a hash
   * is found there, it'll stop the traversal and not mark it as remote.
   * in this example, during the merge, lane-a was fetched, and the remote-ref of this lane has snap-x as the head.
   */
  async setDivergeData(repo: Repository, throws = true, fromCache = true, workspaceId?: ComponentID): Promise<void> {
    if (!this.divergeData || !fromCache) {
      const remoteHead = (this.laneId ? this.calculatedRemoteHeadWhenOnLane : this.remoteHead) || null;
      // this is for detach-head scenario. it can happen on main only. we want to compare against the .bitmap
      // version (which is the detached head) and not the actual head.
      const workspaceVersion = !this.isOnLane() && workspaceId?.hasVersion() ? workspaceId.version : null;
      this.divergeData = await getDivergeData({
        repo,
        modelComponent: this,
        targetHead: remoteHead,
        sourceHead: workspaceVersion ? this.getRef(workspaceVersion) : undefined,
        throws,
      });
    }
  }

  isOnLane(): boolean {
    return Boolean(this.laneHeadLocal || this.laneHeadLocal === null);
  }

  /**
   * this is used (among others) by `bit status` to check whether snaps are local (staged), for `bit reset` to remove them
   * and for `bit export` to push them. for "merge pending" status, use `this.getDivergeDataForMergePending()`.
   */
  getDivergeData(): SnapsDistance {
    if (!this.divergeData)
      throw new Error(
        `getDivergeData() expects divergeData to be populate, please use this.setDivergeData() for id: ${this.id()}`
      );
    return this.divergeData;
  }

  /**
   * don't use modelComponent.getDivergeData() because in some scenarios when on a lane, it compares the head
   * on the lane against the head on the main, which could show the component as diverged incorrectly.
   */
  async getDivergeDataForMergePending(repo: Repository) {
    return getDivergeData({
      repo,
      modelComponent: this,
      targetHead: (this.laneId ? this.laneHeadRemote : this.remoteHead) || null,
      throws: false,
    });
  }

  async populateLocalAndRemoteHeads(repo: Repository, lane?: Lane) {
    this.setLaneHeadLocal(lane);
    if (lane) this.laneId = lane.toLaneId();
    if (!this.scope) {
      return; // no remote to update. it's local.
    }
    this.remoteHead = await repo.remoteLanes.getRef(LaneId.from(DEFAULT_LANE, this.scope), this.toComponentId());
    if (!lane) {
      return;
    }
    this.laneHeadRemote = lane.isNew ? null : await repo.remoteLanes.getRef(lane.toLaneId(), this.toComponentId());

    const calculateRemote = async () => {
      if (this.laneHeadRemote) return this.laneHeadRemote;
      if (lane.isNew && lane.forkedFrom && lane.forkedFrom.scope === lane.scope) {
        // the last check is to make sure that if this lane will be exported to a different scope than the original
        // lane, all snaps of the original lane will be considered as local and will be exported later on.
        const headFromFork = await repo.remoteLanes.getRef(lane.forkedFrom, this.toComponentId());
        if (headFromFork) return headFromFork;
      }
      // if no remote-ref was found, because it's checked out to a lane, it's safe to assume that
      // this.head should be on the original-remote. hence, FetchMissingHistory will retrieve it on lane-remote
      return this.remoteHead || this.head;
    };

    this.calculatedRemoteHeadWhenOnLane = await calculateRemote();
  }

  setLaneHeadLocal(lane?: Lane) {
    if (lane) {
      this.laneHeadLocal = lane.getComponentHead(this.toComponentId());
    }
  }

  /**
   * returns only the versions that exist in both components (regardless whether the hash are the same)
   * e.g. this.component = [0.0.1, 0.0.2, 0.0.3], other component = [0.0.3, 0.0.4]. it returns only [0.0.3].
   * also, in case it is coming from 'bit import', the version must be locally changed.
   * otherwise, it doesn't matter whether the hashes are different.
   */
  _getComparableVersionsObjects(
    otherComponent: Component, // in case of merging, the otherComponent is the existing component, and "this" is the incoming component
    local: boolean // for 'bit import' the local is true, for 'bit export' the local is false
  ): { thisComponentVersions: Versions; otherComponentVersions: Versions } {
    const otherLocalVersion = otherComponent.getLocalVersions();
    const otherComponentVersions = pickBy(
      otherComponent.versions,
      (val, key) => Object.keys(this.versions).includes(key) && (!local || otherLocalVersion.includes(key))
    );
    const thisComponentVersions = pickBy(
      this.versions,
      (val, key) => Object.keys(otherComponentVersions).includes(key) && (!local || otherLocalVersion.includes(key))
    );
    return { thisComponentVersions, otherComponentVersions };
  }

  compatibleWith(component: Component, local: boolean): boolean {
    const { thisComponentVersions, otherComponentVersions } = this._getComparableVersionsObjects(component, local);
    return isEqual(thisComponentVersions, otherComponentVersions);
  }

  diffWith(component: Component, local: boolean): string[] {
    const { thisComponentVersions, otherComponentVersions } = this._getComparableVersionsObjects(component, local);
    return Object.keys(thisComponentVersions).filter(
      (version) => thisComponentVersions[version].hash !== otherComponentVersions[version].hash
    );
  }

  isEmpty() {
    return isEmpty(this.versions) && !this.hasHead();
  }

  /**
   * on main return main head, on lane, return lane head.
   * if the head is also a tag, return the tag, otherwise, return the hash.
   */
  getHeadRegardlessOfLaneAsTagOrHash(returnVersionZeroForNoHead = false): string {
    const head = this.getHeadRegardlessOfLane();
    if (!head) {
      if (!isEmpty(this.versions))
        throw new Error(`error: ${this.id()} has tags but no head, it might be originated from legacy`);
      if (returnVersionZeroForNoHead) return VERSION_ZERO;
      throw new Error(`getHeadRegardlessOfLaneAsTagOrHash() failed finding a head for ${this.id()}`);
    }
    return this.getTagOfRefIfExists(head) || head.toString();
  }

  /**
   * get the recent head. if locally is ahead, return the local head. otherwise, return the remote head.
   *
   * a user can be checked out to a lane, in which case, `this.laneHeadLocal` and `this.laneHeadRemote`
   * may be populated.
   * `this.head` may not be populated, e.g. when a component was created on
   * this lane and never got snapped on main.
   * it's impossible that `this.head.isEqual(this.laneHeadLocal)`, because when snapping it's either
   * on main, which goes to this.head OR on a lane, which goes to this.laneHeadLocal.
   */
  async headIncludeRemote(repo: Repository): Promise<string> {
    const latestLocally = this.getHeadRegardlessOfLaneAsTagOrHash(true);
    const remoteHead = this.laneHeadRemote || this.remoteHead;
    if (!remoteHead) return latestLocally;
    if (!this.getHeadRegardlessOfLane()) {
      return remoteHead.toString(); // in case a snap was created on another lane
    }

    // either a user is on main or a lane, check whether the remote is ahead of the local
    if (this.laneId && !this.laneHeadRemote) {
      // when on a lane, setDivergeData is using the `this.calculatedRemoteHeadWhenOnLane`,
      // which takes into account main-head and forked-head. here, we don't want this. we care only about the
      // remote-lane head.
      return latestLocally;
    }
    await this.setDivergeData(repo, false);
    const divergeData = this.getDivergeData();
    if (divergeData.isTargetAhead()) {
      return this.getTagOfRefIfExists(remoteHead) || remoteHead.toString();
    }
    return latestLocally;
  }

  async getRefOfAncestor(repo: Repository, generationsToGoBack: number): Promise<Ref> {
    const head = this.getHeadRegardlessOfLane();
    if (!head) throw new BitError(`getRefOfAncestor failed to find the head of ${this.id()}`);
    const versionHistory = await this.getAndPopulateVersionHistory(repo, head);
    return versionHistory.getAncestor(generationsToGoBack, head);
  }

  latestVersion(): string {
    if (isEmpty(this.versions)) return VERSION_ZERO;
    return getLatestVersion(this.listVersions());
  }

  latestVersionIfExist(): string | undefined {
    if (isEmpty(this.versions)) return undefined;
    return getLatestVersion(this.listVersions());
  }

  // @todo: make it readable, it's a mess
  isLatestGreaterThan(version: string | null | undefined): boolean {
    if (!version) throw TypeError('isLatestGreaterThan expect to get a Version');
    const latest = this.getHeadRegardlessOfLaneAsTagOrHash(true);
    if (this.isEmpty() && !this.calculatedRemoteHeadWhenOnLane) {
      return false; // in case a snap was created on another lane
    }
    if (isTag(latest) && isTag(version)) {
      return semver.gt(latest, version);
    }
    if (latest === version) return false;
    const latestRef = this.getRef(latest);
    if (!latestRef) throw new Error('isLatestGreaterThan, latestRef was not found');
    const latestHash = latestRef.toString();
    const versionRef = this.getRef(version);
    if (!versionRef) return true; // probably a child
    const versionHash = versionRef.toString();
    if (latestHash === versionHash) return false;
    return true;
  }

  /**
   * Return the lateset version which actuall exists in the scope
   * (exists means the object itself exists)
   * This relevant for cases when the component version array has few versions
   * but we don't have all the refs in the object
   *
   * @returns {number}
   * @memberof Component
   */
  latestExisting(repository: Repository): string {
    if (isEmpty(this.versions)) return VERSION_ZERO;
    const versions = this.listVersions('ASC');
    let version = null;
    let versionStr = null;
    while (!version && versions && versions.length) {
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      versionStr = versions.pop();
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      version = this.loadVersionSync(versionStr, repository, false);
    }
    return versionStr || VERSION_ZERO;
  }

  /**
   * get component log and sort by the timestamp in ascending order (from the earliest to the latest)
   */
  async collectLogs(scope: Scope, shortHash = false, startFrom?: Ref): Promise<ComponentLog[]> {
    const repo = scope.objects;
    let versionsInfo = await getAllVersionsInfo({ modelComponent: this, repo, throws: false, startFrom });

    // due to recent changes of getting version-history object rather than fetching the entire history, some version
    // objects might be missing. import the component from the remote
    if (
      versionsInfo.some((v) => v.error && errorIsTypeOfMissingObject(v.error)) &&
      this.scope !== repo.scopeJson.name
    ) {
      logger.info(`collectLogs is unable to find some objects for ${this.id()}. will try to import them`);
      try {
        const lane = await scope.getCurrentLaneObject();
        await scope.scopeImporter.importWithoutDeps(
          ComponentIdList.fromArray([this.toComponentId()]).toVersionLatest(),
          {
            cache: false,
            includeVersionHistory: true,
            collectParents: true,
            lane: lane || undefined,
            reason: 'to collect logs (including parents)',
          }
        );
        versionsInfo = await getAllVersionsInfo({ modelComponent: this, repo, throws: false, startFrom });
      } catch (err) {
        logger.error(`collectLogs failed to import ${this.id()} history`, err);
      }
    }

    const head = this.getHeadRegardlessOfLane();
    const headVersion = head ? ((await repo.load(head)) as unknown as Version) : undefined;
    const removeAspect = headVersion?.extensions.findCoreExtension(Extensions.remove);
    const removeRange = removeAspect?.config.range;
    const removeSnaps = removeAspect?.config.snaps || [];
    const deprecationAspect = headVersion?.extensions.findCoreExtension(Extensions.deprecation);
    const deprecationRange = deprecationAspect?.config.range;

    const getRef = (ref: Ref) => (shortHash ? ref.toShortString() : ref.toString());
    const results = versionsInfo.map((versionInfo) => {
      const log = versionInfo.version ? versionInfo.version.log : { message: '<no-data-available>' };
      return {
        ...log, // @ts-ignore
        username: log?.username || 'unknown',
        // @ts-ignore
        email: log?.email || 'unknown',
        tag: versionInfo.tag,
        hash: getRef(versionInfo.ref),
        parents: versionInfo.parents.map((parent) => getRef(parent)),
        onLane: versionInfo.onLane,
        deleted:
          (versionInfo.tag && removeRange && semver.satisfies(versionInfo.tag, removeRange)) ||
          (!versionInfo.tag && removeSnaps.includes(versionInfo.ref.toString())),
        deprecated: versionInfo.tag && deprecationRange && semver.satisfies(versionInfo.tag, deprecationRange),
        hidden: versionInfo.version?.hidden,
      };
    });
    // sort from earliest to latest
    const sorted = results.sort((a: ComponentLog, b: ComponentLog) => {
      // @ts-ignore
      if (a.date && b.date) return a.date - b.date;
      return 0;
    });
    return sorted;
  }

  collectVersions(repo: Repository): Promise<ConsumerComponent[]> {
    return Promise.all(
      this.listVersions().map((versionNum) => {
        // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
        return this.toConsumerComponent(versionNum, this.scope, repo);
      })
    );
  }

  getTagOfRefIfExists(ref: Ref, allTags = this.versionsIncludeOrphaned): string | undefined {
    return Object.keys(allTags).find((versionRef) => allTags[versionRef].isEqual(ref));
  }

  getTag(version: string): string | undefined {
    if (isTag(version)) return version;
    const ref = Ref.from(version);
    return this.getTagOfRefIfExists(ref);
  }

  switchHashesWithTagsIfExist(refs: Ref[]): string[] {
    // cache the this.versionsIncludeOrphaned results into "allTags", looks strange but it improved
    // the performance on bit-bin with 188 components during source.merge in 4 seconds.
    const allTags = this.versionsIncludeOrphaned;
    return refs.map((ref) => this.getTagOfRefIfExists(ref, allTags) || ref.toString());
  }

  /**
   * if exactVersion is defined, add exact version instead of using the semver mechanism
   */
  getVersionToAdd(
    releaseType: semver.ReleaseType = DEFAULT_BIT_RELEASE_TYPE,
    exactVersion?: string | null,
    incrementBy?: number,
    preReleaseId?: string
  ): string {
    if (exactVersion && this.versions[exactVersion]) {
      throw new VersionAlreadyExists(exactVersion, this.id());
    }
    const version = exactVersion || this.version(releaseType, incrementBy, preReleaseId);
    validateVersion(version);
    return version;
  }

  isEqual(component: Component, considerOrphanedVersions = true): boolean {
    if ((this.hasHead() && !component.hasHead()) || (!this.hasHead() && component.hasHead())) {
      return false; // only one of them has head
    }
    if (this.head && component.head && !this.head.isEqual(component.head)) {
      return false; // the head is not equal.
    }
    // the head is equal or they both don't have head. check the versions
    if (this.versionArray.length !== component.versionArray.length) {
      return false;
    }
    const hasSameVersions = Object.keys(this.versions).every(
      (tag) => component.versions[tag] && component.versions[tag].isEqual(this.versions[tag])
    );
    if (considerOrphanedVersions) {
      if (Object.keys(this.orphanedVersions).length !== Object.keys(component.orphanedVersions).length) {
        return false;
      }
      const hasSameOrphanedVersions = Object.keys(this.orphanedVersions).every(
        (tag) => component.orphanedVersions[tag] && component.orphanedVersions[tag].isEqual(this.orphanedVersions[tag])
      );
      if (!hasSameOrphanedVersions) {
        return false;
      }
    }

    return hasSameVersions;
  }

  // eslint-disable-next-line complexity
  addVersion(
    version: Version,
    versionToAdd: string,
    lane?: Lane,
    previouslyUsedVersion?: string,
    { addToUpdateDependentsInLane, setHeadAsParent, detachHead, overrideHead }: AddVersionOpts = {}
  ): string {
    if (detachHead && overrideHead) {
      throw new Error(`addVersion expects either detachHead or overrideHead to be true, not both`);
    }
    if (lane) {
      if (isTag(versionToAdd)) {
        throw new BitError(
          'unable to tag when checked out to a lane, please switch to main, merge the lane and then tag again'
        );
      }
      const currentBitId = this.toComponentId();
      const versionToAddRef = Ref.from(versionToAdd);
      const parent = previouslyUsedVersion ? this.getRef(previouslyUsedVersion) : null;
      if (!parent) {
        const existingComponentInLane = lane.getComponent(currentBitId);
        const currentHead = (existingComponentInLane && existingComponentInLane.head) || this.getHead();
        if (currentHead) {
          throw new Error(
            `component ${currentBitId.toString()} has a head (${currentHead.toString()}) but previouslyUsedVersion is empty`
          );
        }
      }
      if (parent && !parent.isEqual(versionToAddRef)) {
        version.addAsOnlyParent(parent);
      }
      if (addToUpdateDependentsInLane) {
        lane.addComponentToUpdateDependents(currentBitId.changeVersion(versionToAddRef.toString()));
        lane.setOverrideUpdateDependents(true);
      } else {
        lane.addComponent({ id: currentBitId, head: versionToAddRef, isDeleted: version.isRemoved() });
      }

      if (lane.readmeComponent && lane.readmeComponent.id.fullName === currentBitId.fullName) {
        lane.setReadmeComponent(currentBitId);
      }
      this.laneHeadLocal = versionToAddRef;
      return versionToAdd;
    }
    // user on main
    const head = this.getHead();
    const parent = previouslyUsedVersion ? this.getRef(previouslyUsedVersion) : null;
    if (
      head &&
      head.toString() !== versionToAdd &&
      !this.hasTag(versionToAdd) // happens with auto-snap
    ) {
      // if this is a tag and this tag exists, the same version was added before with a different hash.
      // adding the current head into the parent will result in a non-exist hash in the parent.
      // if this is a hash and it's the same hash as the current head, adding it as a parent
      // results in a parent and a version has the same hash.
      // @todo: fix it in a more elegant way
      const parentToSet = setHeadAsParent ? head : parent;
      version.addAsOnlyParent(parentToSet || head);
    }
    if (parent && head && !parent.isEqual(head) && !overrideHead) {
      if (detachHead) this.detachedHeads.setHead(version.hash());
      else
        throw new Error(`unable to add a new version for "${this.id()}" on main.
this version started from an older version (${previouslyUsedVersion}), and not from the head (${head}).
if this is done intentionally, please re-run with --detach-head (or --override-head if available).
otherwise, please run "bit checkout head" to be up to date, then snap/tag your changes.`);
    } else {
      this.setHead(version.hash());
      this.detachedHeads.clearCurrent();
    }
    if (isTag(versionToAdd)) {
      this.setVersion(versionToAdd, version.hash());
    }
    this.markVersionAsLocal(versionToAdd);
    return versionToAdd;
  }

  version(releaseType: semver.ReleaseType = DEFAULT_BIT_RELEASE_TYPE, incrementBy = 1, preReleaseId?: string): string {
    const increment = (ver: string) => {
      try {
        // don't use "semver.inc" function, it'll swallow the error and return null.
        const incResult = new semver.SemVer(ver).inc(releaseType, preReleaseId);
        return incResult.version;
      } catch (err: any) {
        throw new Error(`unable to increment version "${ver}" with releaseType "${releaseType}" and preReleaseId "${preReleaseId}".
Error from "semver": ${err.message}`);
      }
    };

    const latest = this.latestVersion();
    if (!latest) {
      const isPreReleaseLike = ['prerelease', 'premajor', 'preminor', 'prepatch'].includes(releaseType);
      return isPreReleaseLike ? increment(DEFAULT_BIT_VERSION) : DEFAULT_BIT_VERSION;
    }
    let result = increment(latest);
    if (incrementBy === 1) return result;
    for (let i = 1; i < incrementBy; i += 1) {
      result = increment(result);
    }
    return result;
  }

  id(): string {
    return this.scope ? [this.scope, this.name].join('/') : this.name;
  }

  /**
   * @deprecated use toComponentId() instead
   */
  toBitId(): BitId {
    return new BitId({ scope: this.scope, name: this.name });
  }

  toComponentId(): ComponentID {
    if (!this.scope) throw new Error(`ModelComponent: scope is missing from "${this.name}"`);
    return new ComponentID(this.toBitId());
  }

  /**
   * @deprecated use toComponentIdWithLatestVersion() instead
   */
  toBitIdWithLatestVersion(): BitId {
    return new BitId({ scope: this.scope, name: this.name, version: this.getHeadRegardlessOfLaneAsTagOrHash(true) });
  }

  toComponentIdWithLatestVersion(): ComponentID {
    return ComponentID.fromObject({
      scope: this.scope,
      name: this.name,
      version: this.getHeadRegardlessOfLaneAsTagOrHash(true),
    });
  }

  toComponentIdWithHead(): ComponentID {
    return ComponentID.fromObject({ scope: this.scope, name: this.name, version: this.head?.toString() });
  }

  toBitIdWithLatestVersionAllowNull(): ComponentID {
    const id = this.toComponentIdWithLatestVersion();
    return id.version === VERSION_ZERO ? id.changeVersion(undefined) : id;
  }

  toObject() {
    function versions(vers: Versions) {
      const obj = {};
      forEach(vers, (ref, version) => {
        obj[version] = ref.toString();
      });
      return obj;
    }

    const componentObject = {
      name: this.name,
      scope: this.scope,
      versions: versions(this.versions),
      lang: this.lang,
      deprecated: this.deprecated,
      bindingPrefix: this.bindingPrefix,
      remotes: this.scopesList,
      schema: this.schema,
      detachedHeads: this.detachedHeads.toObject(),
    };
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    if (this.local) componentObject.local = this.local;
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    if (!isEmpty(this.state)) componentObject.state = this.state;
    // @ts-ignore
    if (!isEmpty(this.orphanedVersions)) componentObject.orphanedVersions = versions(this.orphanedVersions);
    const headStr = this.getHeadStr();
    // @ts-ignore
    if (headStr) componentObject.head = headStr;

    return componentObject;
  }

  async loadVersion(versionStr: string, repository: Repository, throws = true): Promise<Version> {
    const versionRef = this.getRef(versionStr);
    if (!versionRef) throw new VersionNotFound(versionStr, this.id());
    const version = await repository.load(versionRef, false);
    if (!version && throws) throw new VersionNotFoundOnFS(versionStr, this.id());
    return version as Version;
  }

  loadVersionSync(version: string, repository: Repository, throws = true): Version {
    const versionRef = this.getRef(version);
    if (!versionRef) throw new VersionNotFound(version, this.id());
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    return versionRef.loadSync(repository, throws);
  }

  async collectVersionsObjects(
    repo: Repository,
    versions: string[],
    throwForMissingLocalArtifacts = false,
    workspaceId?: ComponentID
  ): Promise<ObjectItem[]> {
    const refsWithoutArtifacts: Ref[] = [];
    const artifactsRefs: Ref[] = [];
    const artifactsRefsFromExportedVersions: Ref[] = [];
    const locallyChangedVersions = await this.getLocalTagsOrHashes(repo, workspaceId);
    const locallyChangedHashes = locallyChangedVersions.map((v) =>
      isTag(v) ? this.versionsIncludeOrphaned[v].hash : v
    );
    const versionsRefs = versions.map((version) => this.getRef(version) as Ref);
    refsWithoutArtifacts.push(...versionsRefs);

    const versionsObjects: Version[] = await Promise.all(
      versionsRefs.map((versionRef) => this.loadVersion(versionRef.toString(), repo))
    );
    versionsObjects.forEach((versionObject) => {
      const refs = versionObject.refsWithOptions(false, false);
      refsWithoutArtifacts.push(...refs);
      const refsFromExtensions = getRefsFromExtensions(versionObject.extensions);
      locallyChangedHashes.includes(versionObject.hash().toString())
        ? artifactsRefs.push(...refsFromExtensions)
        : artifactsRefsFromExportedVersions.push(...refsFromExtensions);
    });
    const loadedRefs: ObjectItem[] = [];
    try {
      const loaded = await repo.loadManyRaw(refsWithoutArtifacts);
      loadedRefs.push(...loaded);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        throw new Error(`unable to find an object file "${err.path}"
for a component "${this.id()}", versions: ${versions.join(', ')}`);
      }
      throw err;
    }
    try {
      const loaded = throwForMissingLocalArtifacts
        ? await repo.loadManyRaw(artifactsRefs)
        : await repo.loadManyRawIgnoreMissing(artifactsRefs);
      loadedRefs.push(...loaded);
      // ignore missing artifacts when exporting old versions that were exported in the past and are now exported to a
      // different scope. this is happening for example when exporting a lane that has components from different
      // remotes. it's ok to not have all artifacts from the other remotes to this remote.
      const loadedExportedArtifacts = await repo.loadManyRawIgnoreMissing(artifactsRefsFromExportedVersions);
      loadedRefs.push(...loadedExportedArtifacts);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        throw new Error(`unable to find an artifact object file "${err.path}"
for a component "${this.id()}", versions: ${versions.join(', ')}
consider using --ignore-missing-artifacts flag if you're sure the artifacts are in the remote`);
      }
      throw err;
    }
    return loadedRefs;
  }

  async collectObjects(repo: Repository): Promise<ComponentObjects> {
    try {
      const [rawComponent, objects] = await Promise.all([this.asRaw(repo), this.collectRaw(repo)]);
      return new ComponentObjects(
        rawComponent,
        objects.map((o) => o.buffer)
      );
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        throw new Error(
          `fatal: an object of "${this.id()}" was not found at ${err.path}\nplease try to re-import the component`
        );
      }
      throw err;
    }
  }

  /**
   * to delete a version from a component, don't call this method directly. Instead, use sources.removeVersion()
   */
  removeVersion(version: string): Ref {
    const objectRef = this.getRef(version);
    if (!objectRef) throw new Error(`removeVersion failed finding version ${version}`);
    delete this.versions[version];
    if (this.state.versions && this.state.versions[version]) delete this.state.versions[version];
    return objectRef;
  }

  toComponentVersion(versionStr?: string): ComponentVersion {
    const versionParsed = versionParser(versionStr);
    const versionNum = versionParsed.latest
      ? this.getHeadRegardlessOfLaneAsTagOrHash(true)
      : (versionParsed.versionNum as string);
    if (versionNum === VERSION_ZERO) {
      throw new NoHeadNoVersion(this.id());
    }
    if (isTag(versionNum) && !this.hasTagIncludeOrphaned(versionNum)) {
      throw new BitError(
        `the version ${versionNum} of "${this.id()}" does not exist in ${this.listVersionsIncludeOrphaned().join(
          '\n'
        )}, versions array.`
      );
    }
    return new ComponentVersion(this, versionNum);
  }

  /**
   * if no "specificVersion" is given, it returns according to the head
   */
  async isDeprecated(repo: Repository, specificVersion?: string) {
    // backward compatibility
    if (this.deprecated) {
      return true;
    }
    const head = this.getHeadRegardlessOfLane();
    if (!head) {
      // it's legacy, or new. If legacy, the "deprecated" prop should do. if it's new, the workspace should
      // have the answer.
      return false;
    }
    const headVersion = (await repo.load(head)) as Version;
    if (!headVersion) {
      // the head Version doesn't exist locally, there is no way to know whether it's deprecated
      return null;
    }
    const deprecationAspect = headVersion.extensions.findCoreExtension(Extensions.deprecation);
    if (!deprecationAspect) {
      return false;
    }
    if (deprecationAspect.config.deprecate) {
      return true;
    }
    if (specificVersion && deprecationAspect.config.range) {
      const tag = this.getTag(specificVersion);
      if (!tag) return false; // it's a snap. "range" doesn't support deprecating snaps. only semver.
      return semver.satisfies(tag, deprecationAspect.config.range);
    }
    return false;
  }

  async isRemoved(repo: Repository, specificVersion?: string): Promise<boolean | null> {
    const getHead = () => {
      if (!this.laneHeadLocal) return this.getHead();
      // you're checked out to a lane.
      if (!specificVersion) return this.laneHeadLocal;
      // it's possible that this specificVersion is from main.
      if (specificVersion === this.laneHeadLocal.toString()) return this.laneHeadLocal;
      return this.getHead();
    };
    const head = getHead();
    if (!head) {
      // it's new or only on lane
      return false;
    }
    const headVersion = (await repo.load(head)) as Version;
    if (!headVersion) {
      // the head Version doesn't exist locally, there is no way to know whether it's removed
      return null;
    }
    const removeAspect = headVersion.extensions.findCoreExtension(Extensions.remove);
    if (!removeAspect) {
      return false;
    }
    if (removeAspect.config.removed) {
      return true;
    }
    if (specificVersion) {
      if (removeAspect.config.range) {
        const tag = this.getTag(specificVersion);
        if (tag) return semver.satisfies(tag, removeAspect.config.range);
      }
      if (removeAspect.config.snaps && Array.isArray(removeAspect.config.snaps)) {
        return removeAspect.config.snaps.includes(specificVersion);
      }
    }
    return false;
  }

  async isLaneReadmeOf(repo: Repository): Promise<string[]> {
    const head = this.getHeadRegardlessOfLane();
    if (!head) {
      // we dont support lanes in legacy
      return [];
    }
    const version = (await repo.load(head)) as Version;
    if (!version) {
      // the head Version doesn't exist locally, there is no way to know whether it is a lane readme component
      return [];
    }
    const lanesAspect = version.extensions.findCoreExtension(Extensions.lanes);
    if (!lanesAspect || !lanesAspect.config.readme) {
      return [];
    }
    return Object.keys(lanesAspect.config.readme);
  }
  /**
   * convert a ModelComponent of a specific version to ConsumerComponent
   * @see sources.consumerComponentToVersion() for the opposite action.
   */
  async toConsumerComponent(versionStr: string, scopeName: string, repository: Repository): Promise<ConsumerComponent> {
    logger.trace(`model-component, converting ${this.id()}, version: ${versionStr} to ConsumerComponent`);
    let componentVersion = this.toComponentVersion(versionStr);
    const version: Version = await componentVersion.getVersion(repository);
    // in case the the version is a short-hash, it should be converted to a full hash.
    if (
      versionStr !== LATEST_VERSION &&
      !isTag(versionStr) &&
      !isSnap(versionStr) &&
      version.hash().toString() !== versionStr
    ) {
      componentVersion = new ComponentVersion(this, version.hash().toString());
    }
    const loadFileInstance = (ClassName) => async (file) => {
      const loadP = file.file.load(repository);
      const content: Source = await loadP;
      if (!content)
        throw new BitError(`failed loading file ${file.relativePath} from the model of ${this.id()}@${versionStr}`);
      return new ClassName({ base: '.', path: file.relativePath, contents: content.contents, test: file.test });
    };
    const filesP = version.files ? Promise.all(version.files.map(loadFileInstance(SourceFile))) : null;
    // @todo: this is weird. why the scopeMeta would be taken from the current scope and not he component scope?
    const scopeMetaP = scopeName ? ScopeMeta.fromScopeName(scopeName).load(repository) : Promise.resolve();
    const log = version.log || null;
    // @ts-ignore
    const [files, scopeMeta] = await Promise.all([filesP, scopeMetaP]);

    const extensions = version.extensions.clone();
    // when generating a new ConsumerComponent out of Version, it is critical to make sure that
    // all objects are cloned and not copied by reference. Otherwise, every time the
    // ConsumerComponent instance is changed, the Version will be changed as well, and since
    // the Version instance is saved in the Repository._cache, the next time a Version instance
    // is retrieved, it'll be different than the first time.
    const consumerComponent = new ConsumerComponent({
      name: this.name,
      version: componentVersion.version,
      scope: this.toComponentId()._legacy.scope,
      defaultScope: this.scope,
      lang: this.lang,
      bindingPrefix: this.bindingPrefix,
      mainFile: version.mainFile,
      dependencies: this.addDepsInfoFromDepsResolver(version.dependencies, extensions),
      devDependencies: this.addDepsInfoFromDepsResolver(version.devDependencies, extensions),
      flattenedDependencies: version.flattenedDependencies.clone(),
      packageDependencies: clone(version.packageDependencies),
      devPackageDependencies: clone(version.devPackageDependencies),
      peerPackageDependencies: clone(version.peerPackageDependencies),
      // @ts-ignore
      files,
      docs: version.docs,
      // @ts-ignore
      license: scopeMeta ? License.deserialize(scopeMeta.license) : undefined, // todo: make sure we have license in case of local scope
      log,
      overrides: ComponentOverrides.loadFromScope(version.overrides),
      packageJsonChangedProps: clone(version.packageJsonChangedProps),
      deprecated: this.deprecated,
      removed: version.isRemoved(),
      scopesList: clone(this.scopesList),
      schema: version.schema,
      extensions,
      buildStatus: version.buildStatus,
    });

    return consumerComponent;
  }

  private addDepsInfoFromDepsResolver(dependencies: Dependencies, extensions: ExtensionDataList): Dependency[] {
    const cloned = dependencies.getClone();
    const depsResolverData = extensions.find((ext) => ext.name === 'teambit.dependencies/dependency-resolver');
    if (!depsResolverData) return cloned;
    cloned.forEach((dependency) => {
      if (dependency.packageName) return;
      const matchedEntry = depsResolverData.data?.dependencies?.find((entry) => {
        return dependency.id.toString() === entry.id;
      });
      if (matchedEntry) {
        dependency.packageName = matchedEntry.packageName;
      }
    });
    return cloned;
  }

  // @todo: make sure it doesn't have the same ref twice, once as a version and once as a head
  refs(): Ref[] {
    const versions = Object.values(this.versionsIncludeOrphaned);
    if (this.head) versions.push(this.head);
    return versions;
  }

  validateBeforePersisting(componentStr: string): void {
    logger.trace(`validating component object: ${this.hash().hash} ${this.id()}`);
    const component = Component.parse(componentStr);
    component.validate();
  }

  toBuffer(pretty: boolean) {
    const args = getStringifyArgs(pretty);
    const obj = this.toObject();
    const str = JSON.stringify(obj, ...args);
    if (this.validateBeforePersist) this.validateBeforePersisting(str);
    return Buffer.from(str);
  }

  /**
   * Clear data that is relevant only for the local scope and should not be moved to the remote scope
   */
  clearStateData() {
    this.local = false; // backward compatibility for components created before 0.12.6
    this.state = {};
  }

  markVersionAsLocal(version: string) {
    if (!this.state.versions) this.state = { versions: {} };
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    if (!this.state.versions[version]) this.state.versions[version] = {};
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    this.state.versions[version].local = true;
  }

  /**
   * local versions that are not exported on the main lane.
   * @see `this.getLocalTagsOrHashes()`, to get local snaps on the current lane
   */
  getLocalVersions(): string[] {
    if (isEmpty(this.state) || isEmpty(this.state.versions)) return [];
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    return Object.keys(this.state.versions).filter((version) => this.state.versions[version].local);
  }

  hasLocalTag(tag: string): boolean {
    const localVersions = this.getLocalVersions();
    return localVersions.includes(tag);
  }

  async getLocalTagsOrHashes(repo: Repository, workspaceId?: ComponentID): Promise<string[]> {
    const localHashes = await this.getLocalHashes(repo, workspaceId);
    if (!localHashes.length) return [];
    return this.switchHashesWithTagsIfExist(localHashes).reverse(); // reverse to get the older first
  }

  async getLocalHashes(repo: Repository, workspaceId?: ComponentID): Promise<Ref[]> {
    await this.setDivergeData(repo, undefined, undefined, workspaceId);
    const divergeData = this.getDivergeData();
    const localHashes = divergeData.snapsOnSourceOnly;
    if (!localHashes.length) return [];
    return localHashes.reverse(); // reverse to get the older first
  }

  /**
   * for most cases, use `isLocallyChanged`, which takes into account lanes.
   * this is for cases when we only care about the versions exist in the `state` prop.
   */
  isLocallyChangedRegardlessOfLanes(): boolean {
    return Boolean(this.getLocalVersions().length);
  }

  /**
   * whether the component was locally changed, either by adding a new snap/tag or by merging
   * components from different lanes.
   */
  async isLocallyChanged(repo: Repository, lane?: Lane | null, workspaceId?: ComponentID): Promise<boolean> {
    if (lane) await this.populateLocalAndRemoteHeads(repo, lane);
    await this.setDivergeData(repo, undefined, undefined, workspaceId);
    const divergeData = this.getDivergeData();
    return divergeData.isSourceAhead();
  }

  async getVersionHistory(repo: Repository): Promise<VersionHistory> {
    const emptyVersionHistory = VersionHistory.fromId(this.name, this.scope);
    const versionHistory = await repo.load(emptyVersionHistory.hash());
    return (versionHistory || emptyVersionHistory) as VersionHistory;
  }

  async getAndPopulateVersionHistory(repo: Repository, head: Ref): Promise<VersionHistory> {
    const versionHistory = await this.getVersionHistory(repo);
    const { err } = await this.populateVersionHistoryIfMissingGracefully(repo, versionHistory, head);
    if (err) {
      logger.error(`rethrowing an error ${err.message}, current stuck`, new Error(err.message));
      throw err;
    }
    return versionHistory;
  }

  /**
   * careful! the `versions` passed here can belong to other components, not necessarily to this one.
   * that's why it checks whether the version-hash exists in the VersionHistory, and if it's not,
   * it won't update it.
   */
  async updateRebasedVersionHistory(repo: Repository, versions: Version[]): Promise<VersionHistory | undefined> {
    const versionHistory = await this.getVersionHistory(repo);
    const hasUpdated = versions.some((version) => {
      const versionData = versionHistory.getVersionData(version.hash());
      if (!versionData) return false;
      versionHistory.addFromVersionsObjects([version]);
      return true;
    });

    return hasUpdated ? versionHistory : undefined;
  }

  async updateVersionHistory(repo: Repository, versions: Version[]): Promise<VersionHistory> {
    const versionHistory = await this.getVersionHistory(repo);
    versionHistory.addFromVersionsObjects(versions);
    logger.debug(`updating version history of ${this.id()} with ${versions.length} versions`);
    return versionHistory;
  }

  async populateVersionHistoryIfMissingGracefully(
    repo: Repository,
    versionHistory: VersionHistory,
    head: Ref,
    /**
     * during traversal, if a hash is found in the VersionHistory it probably means that it has all history until this
     * point, so we can stop there for better performance. In some rare cases (e.g. the export was interrupted), we
     * need the ability of full traversal to repair the VersionHistory.
     */
    exitWhenFind = true
  ): Promise<{ err?: Error; added?: VersionParents[] }> {
    const headExists = versionHistory.hasHash(head);
    if (exitWhenFind && headExists) return {};
    const getVersionObj = async (ref: Ref) => (await ref.load(repo)) as Version | undefined;
    const versionsToAdd: Version[] = [];
    let err: Error | undefined;
    const addParentsRecursively = async (version: Version) => {
      await pMapSeries(version.parents, async (parent) => {
        const foundParent = versionHistory.hasHash(parent) || versionsToAdd.find((v) => v.hash().isEqual(parent));
        if (exitWhenFind && foundParent) {
          return;
        }
        const parentVersion = await getVersionObj(parent);
        if (!parentVersion) {
          const tag = this.getTagOfRefIfExists(parent);
          err = tag
            ? new VersionNotFound(tag, this.id())
            : new ParentNotFound(this.id(), version.hash().toString(), parent.toString());
          return;
        }
        versionsToAdd.push(parentVersion);
        await addParentsRecursively(parentVersion);
      });
    };
    const headVer = await getVersionObj(head);
    if (!headVer) {
      return { err: new HeadNotFound(this.id(), head.toString()) };
    }
    return this.populateVersionHistoryMutex.runExclusive(async () => {
      if (!headExists) versionsToAdd.push(headVer);
      await addParentsRecursively(headVer);
      const added = versionsToAdd.map((v) => getVersionParentsFromVersion(v));
      if (err) {
        return { err, added };
      }
      versionHistory.addFromVersionsObjects(versionsToAdd);
      logger.debug(
        `populateVersionHistoryIfMissingGracefully, updating ${this.id()} with ${versionsToAdd.length} versions`
      );
      await repo.writeObjectsToTheFS([versionHistory]);
      return { added };
    });
  }

  static parse(contents: string): Component {
    const rawComponent = JSON.parse(contents);
    return Component.from({
      name: rawComponent.box ? `${rawComponent.box}/${rawComponent.name}` : rawComponent.name,
      scope: rawComponent.scope,
      versions: mapValues(rawComponent.versions as Record<string, string>, (val) => Ref.from(val)),
      lang: rawComponent.lang,
      deprecated: rawComponent.deprecated,
      bindingPrefix: rawComponent.bindingPrefix,
      state: rawComponent.state,
      orphanedVersions: mapValues(rawComponent.orphanedVersions || {}, (val) => Ref.from(val)),
      scopesList: rawComponent.remotes,
      head: rawComponent.head ? Ref.from(rawComponent.head) : undefined,
      schema: rawComponent.schema || (rawComponent.head ? SchemaName.Harmony : SchemaName.Legacy),
      detachedHeads: DetachedHeads.fromObject(rawComponent.detachedHeads),
    });
  }

  static from(props: ComponentProps): Component {
    return new Component(props);
  }

  static fromBitId(bitId: ComponentID): Component {
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    return new Component({
      name: bitId.fullName,
      scope: bitId.scope,
    });
  }

  get isLegacy(): boolean {
    return !this.schema || this.schema === SchemaName.Legacy;
  }

  validate(): void {
    const message = `unable to save Component object "${this.id()}"`;
    if (!this.name) throw new BitError(`${message} the name is missing`);
    if (this.state && this.state.versions) {
      Object.keys(this.state.versions).forEach((version) => {
        if (isTag(version) && !this.hasTag(version)) {
          throw new ValidationError(`${message}, the version ${version} is marked as staged but is not available`);
        }
      });
    }
    const hashDuplications = findDuplications(this.versionArray.map((v) => v.toString()));
    if (hashDuplications.length) {
      throw new ValidationError(`${message}, the following hash(es) are duplicated ${hashDuplications.join(', ')}`);
    }
    Object.keys(this.orphanedVersions).forEach((version) => {
      if (this.versions[version]) {
        throw new ValidationError(
          `${message}, the version "${version}" exists in orphanedVersions but it exits also in "versions" prop`
        );
      }
    });
    if (!this.isLegacy && !this.head && this.versionArray.length) {
      // legacy don't have head. also, when snapping on a lane the first time, there is no head.
      // tags are done on default lane only, so if there are versions (tag), it must have head
      throw new ValidationError(`${message}, the "head" prop is missing`);
    }
  }
}
