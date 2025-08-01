import { ExtensionDataList, ExtensionDataEntry, removeInternalConfigFields } from '@teambit/legacy.extension-data';
import { ComponentID } from '@teambit/component-id';
import type { SerializableMap } from './aspect-entry';
import { AspectEntry } from './aspect-entry';

/**
 * list of aspects, each may have data and artifacts saved per component.
 */
export class AspectList {
  constructor(readonly entries: AspectEntry[]) {}

  addEntry(aspectId: ComponentID, data: SerializableMap = {}) {
    const extensionDataEntry = new ExtensionDataEntry(undefined, aspectId, undefined, {}, data);
    const entry = new AspectEntry(aspectId, extensionDataEntry);
    this.entries.push(entry);
    return entry;
  }

  upsertEntry(aspectId: ComponentID, data: SerializableMap = {}) {
    const existingEntry = this.entries.find((entry) => entry.id.isEqual(aspectId));
    if (existingEntry) {
      existingEntry.data = data;
      return existingEntry;
    }
    return this.addEntry(aspectId, data);
  }

  /**
   * transform an aspect list into a new one without the given aspect ids
   */
  withoutEntries(aspectIds: string[]): AspectList {
    const entries = this.entries.filter((entry) => !aspectIds.includes(entry.legacy.stringId));
    return new AspectList(entries);
  }

  /**
   * get all ids as strings from the aspect list.
   */
  get ids(): string[] {
    const list = this.entries.map((entry) => entry.id.toString());
    return list;
  }

  /**
   * get an aspect from the list using a serialized ID.
   */
  get(id: string): AspectEntry | undefined {
    return this.entries.find((entry) => {
      return entry.legacy.stringId === id || entry.id.toStringWithoutVersion() === id;
    });
  }

  /**
   * find aspect by component ID.
   */
  find(id: ComponentID, ignoreVersion = false): AspectEntry | undefined {
    return this.entries.find((aspectEntry) => {
      return id.isEqual(aspectEntry.id, { ignoreVersion });
    });
  }

  /**
   * transform an aspect list into a new one.
   */
  map(predicate: (entry: AspectEntry) => AspectEntry) {
    const entries = this.entries.map(predicate);
    return new AspectList(entries);
  }

  /**
   * transform an aspect list into a new one.
   */
  async pmap(predicate: (entry: AspectEntry) => Promise<AspectEntry>) {
    const entriesP = this.entries.map(predicate);
    const entries = await Promise.all(entriesP);
    return new AspectList(entries);
  }

  toConfigObject() {
    const res = {};
    this.entries.forEach((entry) => {
      if (entry.config) {
        res[entry.id.toString()] = removeInternalConfigFields(entry.legacy.rawConfig);
      }
    });
    return res;
  }

  serialize() {
    const serializedEntries = this.entries.map((entry) => entry.serialize());
    return serializedEntries;
  }

  filter(ids?: string[]): AspectList {
    if (!ids?.length) return new AspectList(this.entries);
    const entries = this.entries.filter((aspectEntry) => {
      return ids?.includes(aspectEntry.id.toStringWithoutVersion());
    });
    return new AspectList(entries);
  }

  toLegacy(): ExtensionDataList {
    const legacyEntries = this.entries.map((entry) => entry.legacy);
    return ExtensionDataList.fromArray(legacyEntries);
  }

  stringIds(): string[] {
    const ids = this.entries.map((entry) => entry.id.toString());
    return ids;
  }

  clone(): AspectList {
    return new AspectList(this.entries.map((entry) => entry.clone()));
  }

  static fromLegacyExtensions(legacyDataList: ExtensionDataList): AspectList {
    const newEntries = legacyDataList.map((entry) => {
      return new AspectEntry(getAspectId(entry), entry);
    });

    return new AspectList(newEntries);
  }
}

function getAspectId(entry: ExtensionDataEntry) {
  if (!entry.extensionId && entry.name) return ComponentID.fromString(entry.name);
  if (entry.extensionId) return entry.extensionId;
  throw new Error('aspect cannot be loaded without setting an ID');
}
