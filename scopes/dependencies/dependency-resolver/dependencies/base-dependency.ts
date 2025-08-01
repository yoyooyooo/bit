import type { DependencySource } from '../policy/variant-policy/variant-policy';
import type { Dependency, DependencyLifecycleType, DependencyManifest } from './dependency';

export abstract class BaseDependency implements Dependency {
  _type: string;

  constructor(
    private _id: string,
    private _version: string,
    private _lifecycle: DependencyLifecycleType,
    private _source?: DependencySource,
    private _hidden?: boolean,
    private _optional?: boolean,
    private _versionRange?: string
  ) {}

  get id(): string {
    return this._id;
  }

  set id(newId: string) {
    this._id = newId;
  }

  get version() {
    return this._version;
  }

  get versionRange() {
    return this._versionRange;
  }

  get type() {
    return this._type;
  }

  get lifecycle() {
    return this._lifecycle;
  }

  get source() {
    return this._source;
  }

  set source(source) {
    this._source = source;
  }

  set hidden(hidden) {
    this._hidden = hidden;
  }

  get hidden() {
    return this._hidden;
  }

  set optional(optional) {
    this._optional = optional;
  }

  get optional() {
    return this._optional;
  }

  get idWithoutVersion() {
    return this._id;
  }

  serialize<SerializedDependency>(): SerializedDependency {
    return {
      id: this.id,
      version: this.version,
      versionRange: this.versionRange,
      __type: this.type,
      lifecycle: this.lifecycle.toString(),
      source: this.source,
      hidden: this.hidden,
      optional: this.optional,
    } as unknown as SerializedDependency;
  }

  setVersion(newVersion: string) {
    this._version = newVersion;
  }

  getPackageName() {
    return this.id;
  }

  toManifest(): DependencyManifest {
    const packageName = this.getPackageName?.();
    const version = this.version;
    return {
      packageName,
      version,
    };
  }
}
