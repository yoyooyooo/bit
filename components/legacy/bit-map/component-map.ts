import * as path from 'path';
import globby from 'globby';
import ignore from 'ignore';
import { pickBy, isNil, sortBy, isEmpty } from 'lodash';
import type { ComponentID } from '@teambit/component-id';
import { BIT_MAP, Extensions, PACKAGE_JSON, IGNORE_ROOT_ONLY_LIST } from '@teambit/legacy.constants';
import { ValidationError } from '@teambit/legacy.cli.error';
import { logger } from '@teambit/legacy.logger';
import { isValidPath } from '@teambit/legacy.utils';
import {
  retrieveIgnoreList,
  BIT_IGNORE,
  getBitIgnoreFile,
  getGitIgnoreFile,
} from '@teambit/git.modules.ignore-file-reader';
import type {
  PathLinux,
  PathLinuxRelative,
  PathOsBasedAbsolute,
  PathOsBasedRelative,
} from '@teambit/toolbox.path.path';
import { pathJoinLinux, pathNormalizeToLinux, pathRelativeLinux } from '@teambit/toolbox.path.path';
import { removeInternalConfigFields } from '@teambit/legacy.extension-data';
import OutsideRootDir from './exceptions/outside-root-dir';
import { IgnoredDirectory, ComponentNotFoundInPath } from '@teambit/legacy.consumer-component';

export type Config = { [aspectId: string]: Record<string, any> | '-' };

export type ComponentMapFile = {
  relativePath: PathLinux;
  /**
   * @deprecated should be safe to remove around August 2025
   * you can easily get it by running `path.basename(relativePath)`
   */
  name?: string;
  /**
   * @deprecated should be safe to remove around August 2025
   */
  test?: boolean;
};

export type NextVersion = {
  version: 'patch' | 'minor' | 'major' | 'prerelease' | string;
  preRelease?: string;
  message?: string;
  username?: string;
  email?: string;
};

export type ComponentMapData = {
  id: ComponentID;
  files: ComponentMapFile[];
  defaultScope?: string;
  mainFile: PathLinux;
  rootDir: PathLinux;
  wrapDir?: PathLinux;
  exported?: boolean;
  onLanesOnly?: boolean;
  localOnly?: boolean;
  isAvailableOnCurrentLane?: boolean;
  nextVersion?: NextVersion;
  config?: Config;
};

export type PathChange = { from: PathLinux; to: PathLinux };

export class ComponentMap {
  id: ComponentID;
  files: ComponentMapFile[];
  defaultScope?: string;
  mainFile: PathLinux;
  rootDir: PathLinux;
  wrapDir: PathLinux | undefined; // a wrapper directory needed when a user adds a package.json file to the component root so then it won't collide with Bit generated one
  // wether the compiler / tester are detached from the workspace global configuration
  // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
  markBitMapChangedCb: Function;
  exported: boolean | null | undefined; // relevant for authored components only, it helps finding out whether a component has a scope
  isAvailableOnCurrentLane? = true; // if a component was created on another lane, it might not be available on the current lane
  /**
   * @deprecated here for forward compatibility.
   * used to determine whether a component is available only on lanes and not on main
   * schema 15 used this prop, and if it was false/undefined, it assumed the component is available regardless of `isAvailableOnCurrentLane`.
   * schema 16 is not using this prop anymore.
   * this is still here for projects that loaded .bitmap with schema 16 and then downgraded bit to a version with schema 15.
   */
  onLanesOnly? = false;
  localOnly?: boolean; // whether the component is local only and should not be snapped/tagged/exported
  nextVersion?: NextVersion; // for soft-tag (harmony only), this data is used in the CI to persist
  recentlyTracked?: boolean; // eventually the timestamp is saved in the filesystem cache so it won't be re-tracked if not changed
  name: string; // name of the component (including namespace)
  scope?: string | null; // empty string if new/staged. (undefined if legacy).
  version?: string; // empty string if new. (undefined if legacy).
  noFilesError?: Error; // set if during finding the files an error was found
  config?: { [aspectId: string]: Record<string, any> | '-' };
  constructor({
    id,
    files,
    defaultScope,
    mainFile,
    rootDir,
    wrapDir,
    onLanesOnly,
    localOnly,
    isAvailableOnCurrentLane,
    nextVersion,
    config,
  }: ComponentMapData) {
    this.id = id;
    this.files = files;
    this.defaultScope = defaultScope;
    this.mainFile = mainFile;
    this.rootDir = rootDir;
    this.wrapDir = wrapDir;
    this.onLanesOnly = onLanesOnly;
    this.localOnly = localOnly;
    this.isAvailableOnCurrentLane = typeof isAvailableOnCurrentLane === 'undefined' ? true : isAvailableOnCurrentLane;
    this.nextVersion = nextVersion;
    this.config = config;
  }

  static fromJson(componentMapObj: ComponentMapData): ComponentMap {
    return new ComponentMap(componentMapObj);
  }

  toPlainObject(): Record<string, any> {
    let res: Record<string, any> = {
      name: this.name,
      scope: this.scope,
      version: this.version,
      files: null,
      defaultScope: this.defaultScope,
      mainFile: this.mainFile,
      rootDir: this.rootDir,
      wrapDir: this.wrapDir,
      exported: this.exported,
      onLanesOnly: this.onLanesOnly || null, // if false, change to null so it won't be written
      isAvailableOnCurrentLane: this.isAvailableOnCurrentLane,
      nextVersion: this.nextVersion,
      localOnly: this.localOnly || null, // if false, change to null so it won't be written
      config: this.configToObject(),
    };

    res = pickBy(res, (value) => !isNil(value));
    return res;
  }

  configToObject() {
    if (!this.config) return undefined;
    const config = {};
    Object.keys(this.config).forEach((aspectId) => {
      config[aspectId] = removeInternalConfigFields(this.config?.[aspectId]);
    });
    return config;
  }

  static getPathWithoutRootDir(rootDir: PathLinux, filePath: PathLinux): PathLinux {
    const newPath = pathRelativeLinux(rootDir, filePath);
    if (newPath.startsWith('..')) {
      // this is forbidden for security reasons. Allowing files to be written outside the components directory may
      // result in overriding OS files.
      throw new OutsideRootDir(filePath, rootDir);
    }
    return newPath;
  }

  static changeFilesPathAccordingToItsRootDir(existingRootDir: PathLinux, files: ComponentMapFile[]): PathChange[] {
    const changes = [];
    files.forEach((file) => {
      const newPath = this.getPathWithoutRootDir(existingRootDir, file.relativePath);
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      changes.push({ from: file.relativePath, to: newPath });
      file.relativePath = newPath;
    });
    return changes;
  }

  setMarkAsChangedCb(markAsChangedBinded: Function) {
    this.markBitMapChangedCb = markAsChangedBinded;
  }

  _findFile(fileName: PathLinux): ComponentMapFile | undefined {
    return this.files.find((file) => {
      const filePath = this.rootDir ? pathJoinLinux(this.rootDir, file.relativePath) : file.relativePath;
      return filePath === fileName;
    });
  }

  changeRootDirAndUpdateFilesAccordingly(newRootDir: PathLinuxRelative) {
    if (this.rootDir === newRootDir) return;
    this.files.forEach((file) => {
      const filePathRelativeToConsumer = this.rootDir
        ? pathJoinLinux(this.rootDir, file.relativePath)
        : file.relativePath;
      const newPath = ComponentMap.getPathWithoutRootDir(newRootDir, filePathRelativeToConsumer);
      if (this.mainFile === file.relativePath) this.mainFile = newPath;
      file.relativePath = newPath;
    });
    this.rootDir = newRootDir;
  }

  updateDirLocation(dirFrom: PathOsBasedRelative, dirTo: PathOsBasedRelative): PathChange[] {
    dirFrom = pathNormalizeToLinux(dirFrom);
    dirTo = pathNormalizeToLinux(dirTo);
    const changes = [];
    if (this.rootDir && this.rootDir.startsWith(dirFrom)) {
      const rootDir = this.rootDir;
      const newRootDir = rootDir.replace(dirFrom, dirTo);
      const newRootDirNormalized = pathNormalizeToLinux(newRootDir);
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      changes.push({ from: rootDir, to: newRootDirNormalized });
      logger.debug(`updating rootDir location from ${rootDir} to ${newRootDirNormalized}`);
      this.rootDir = newRootDirNormalized;
      return changes;
    }
    this.files.forEach((file) => {
      const filePath = this.rootDir ? path.join(this.rootDir, file.relativePath) : file.relativePath;
      if (filePath.startsWith(dirFrom)) {
        const fileTo = filePath.replace(dirFrom, dirTo);
        const newLocation = this.rootDir ? ComponentMap.getPathWithoutRootDir(this.rootDir, fileTo) : fileTo;
        logger.debug(`updating file location from ${file.relativePath} to ${newLocation}`);
        if (this.mainFile === file.relativePath) this.mainFile = newLocation;
        // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
        // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
        changes.push({ from: file.relativePath, to: newLocation });
        file.relativePath = newLocation;
      }
    });
    this.validate();
    return changes;
  }

  getFilesRelativeToConsumer(): PathLinux[] {
    return this.files.map((file) => {
      return this.rootDir ? pathJoinLinux(this.rootDir, file.relativePath) : file.relativePath;
    });
  }

  getAllFilesPaths(): PathLinux[] {
    return this.files.map((file) => file.relativePath);
  }

  /**
   * this.rootDir is not defined for author. instead, the current workspace is the rootDir
   * also, for imported environments (compiler/tester) components the rootDir is empty
   */
  getRootDir(): PathLinuxRelative {
    return this.rootDir || '.';
  }

  hasRootDir(): boolean {
    return Boolean(this.rootDir && this.rootDir !== '.');
  }

  getComponentDir(): PathLinux {
    return this.rootDir;
  }

  doesAuthorHaveRootDir(): boolean {
    return Boolean(this.rootDir);
  }

  /**
   * if the component dir has changed since the last tracking, re-scan the component-dir to get the
   * updated list of the files
   */
  async trackDirectoryChangesHarmony(consumerPath: PathOsBasedAbsolute): Promise<void> {
    const trackDir = this.rootDir;
    if (!trackDir) {
      return;
    }
    const gitIgnore = await getGitIgnoreHarmony(consumerPath);
    this.files = await getFilesByDir(trackDir, consumerPath, gitIgnore);
  }

  updateNextVersion(nextVersion: NextVersion) {
    this.nextVersion = nextVersion;
    this.validate();
  }

  clearNextVersion() {
    delete this.nextVersion;
  }

  removeFiles(files: ComponentMapFile[]): void {
    const relativePaths = files.map((file) => file.relativePath);
    this.files = this.files.reduce((accumulator, file) => {
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      return relativePaths.includes(file.relativePath) ? accumulator : accumulator.concat(file);
    }, []);
    this.validate();
  }

  isRemoved() {
    const removeAspectConf = this.config?.[Extensions.remove];
    if (!removeAspectConf) return false;
    return removeAspectConf !== '-' && removeAspectConf.removed;
  }
  isRecovered() {
    const removeAspectConf = this.config?.[Extensions.remove];
    if (!removeAspectConf) return false;
    return removeAspectConf !== '-' && removeAspectConf.removed === false;
  }
  isDeprecated() {
    const deprecationConf = this.config?.[Extensions.deprecation];
    if (!deprecationConf) return false;
    return deprecationConf !== '-' && deprecationConf.deprecate;
  }
  isUndeprecated() {
    const deprecationConf = this.config?.[Extensions.deprecation];
    if (!deprecationConf) return false;
    return deprecationConf !== '-' && deprecationConf.deprecate === false;
  }

  sort() {
    this.files = sortBy(this.files, 'relativePath');
  }

  clone() {
    // @ts-ignore - there is some issue with the config dir type
    return new ComponentMap(this);
  }

  validate(): void {
    const errorMessage = `failed adding or updating a ${BIT_MAP} record of ${this.id.toString()}.`;
    if (!this.mainFile) throw new ValidationError(`${errorMessage} mainFile attribute is missing`);
    if (!isValidPath(this.mainFile)) {
      throw new ValidationError(`${errorMessage} mainFile attribute ${this.mainFile} is invalid`);
    }
    if (this.rootDir && !isValidPath(this.rootDir)) {
      throw new ValidationError(`${errorMessage} rootDir attribute ${this.rootDir} is invalid`);
    }
    if (this.rootDir && this.rootDir === '.') {
      throw new ValidationError(`${errorMessage} rootDir attribute ${this.rootDir} is invalid`);
    }
    if (this.nextVersion && !this.nextVersion.version) {
      throw new ValidationError(`${errorMessage} version attribute should be set when nextVersion prop is set`);
    }
    if (this.isRemoved()) {
      // the following validation are related to the files, which don't exist in case of soft-remove
      return;
    }

    if (!this.files || !this.files.length) throw new ValidationError(`${errorMessage} files list is missing`);
    this.files.forEach((file) => {
      if (!isValidPath(file.relativePath)) {
        throw new ValidationError(`${errorMessage} file path ${file.relativePath} is invalid`);
      }
    });
    const foundMainFile = this.files.find((file) => file.relativePath === this.mainFile);
    if (!foundMainFile || isEmpty(foundMainFile)) {
      throw new ValidationError(`${errorMessage} mainFile ${this.mainFile} is not in the files list.
if you renamed the mainFile, please re-add the component with the "--main" flag pointing to the correct main-file`);
    }
    const filesPaths = this.files.map((file) => file.relativePath);
    const duplicateFiles = filesPaths.filter(
      (file) => filesPaths.filter((f) => file.toLowerCase() === f.toLowerCase()).length > 1
    );
    if (duplicateFiles.length) {
      throw new ValidationError(`${errorMessage} the following files are duplicated ${duplicateFiles.join(', ')}`);
    }
  }
}

export async function getFilesByDir(dir: string, consumerPath: string, gitIgnore: any): Promise<ComponentMapFile[]> {
  const matches = await globby(dir, {
    cwd: consumerPath,
    dot: true,
    onlyFiles: true,
    // must ignore node_modules at this stage, although we check for gitignore later on.
    // otherwise, it hurts performance dramatically for components that have node_modules in the comp-dir.
    ignore: [`${dir}/node_modules/`],
  });
  if (!matches.length) throw new ComponentNotFoundInPath(dir);
  const filteredMatches: string[] = gitIgnore.filter(matches);
  // the path is relative to consumer. remove the rootDir.
  const relativePathsLinux = filteredMatches.map((match) => pathNormalizeToLinux(match).replace(`${dir}/`, ''));
  const filteredByIgnoredFromRoot = relativePathsLinux.filter((match) => !IGNORE_ROOT_ONLY_LIST.includes(match));
  const bitOrGitIgnore = filteredByIgnoredFromRoot.includes(BIT_IGNORE)
    ? await getBitIgnoreFile(dir)
    : await getGitIgnoreFile(dir);
  const filteredByBitIgnore = bitOrGitIgnore
    ? ignore().add(bitOrGitIgnore).filter(filteredByIgnoredFromRoot)
    : filteredByIgnoredFromRoot;
  if (!filteredByBitIgnore.length) throw new IgnoredDirectory(dir);
  return filteredByBitIgnore.map((relativePath) => ({
    relativePath,
    test: false,
    name: path.basename(relativePath),
  }));
}

export async function getGitIgnoreHarmony(consumerPath: string): Promise<any> {
  const ignoreList = await getIgnoreListHarmony(consumerPath);
  return ignore().add(ignoreList);
}

export async function getIgnoreListHarmony(consumerPath: string): Promise<string[]> {
  const ignoreList = await retrieveIgnoreList(consumerPath);
  // the ability to track package.json is deprecated since Harmony
  ignoreList.push(PACKAGE_JSON);
  return ignoreList;
}
