import type { Command, CommandOptions } from '@teambit/cli';
import type { ComponentMain } from '@teambit/component';
import pMapSeries from 'p-map-series';
import type { Logger } from '@teambit/logger';
import type { APISchema } from '@teambit/semantics.entities.semantic-schema';
import { PATTERN_HELP } from '@teambit/legacy.constants';
import type { SchemaMain } from './schema.main.runtime';

export class SchemaCommand implements Command {
  name = 'schema <pattern>';
  description =
    'extracts and displays the API schema (types, functions, classes, interfaces) of the specified component/s.';
  extendedDescription = `Extracts TypeScript definitions to provide a comprehensive view of a component's public API.
Shows detailed information about exported elements including classes, interfaces, functions, types, and enums with their respective signatures and documentation.

${PATTERN_HELP('schema')}`;
  group = 'info-analysis';
  options = [
    ['r', 'remote', 'fetch schema from remote scope (works for components not in workspace)'],
    ['j', 'json', 'return the component schema in json format'],
  ] as CommandOptions;

  constructor(
    private schema: SchemaMain,
    private component: ComponentMain,
    private logger: Logger
  ) {}

  async report([pattern]: [string], { remote }: { remote: boolean }): Promise<string> {
    const schemas = await this.getSchemas([pattern], remote);
    return schemas.map((schema) => schema.toStringPerType()).join('\n\n\n');
  }

  async json([pattern]: [string], { remote }: { remote: boolean }): Promise<Record<string, any>> {
    const schemas = await this.getSchemas([pattern], remote);
    return schemas.map((schema) => schema.toObject());
  }

  private async getSchemas([pattern]: [string], remote = false): Promise<APISchema[]> {
    if (remote) {
      const schema = await this.schema.getSchemaFromRemote(pattern);
      return [schema];
    }
    const host = this.component.getHost();
    const ids = await host.idsByPattern(pattern, true);
    const components = await host.getMany(ids);
    const longRunningLog = this.logger.createLongProcessLogger('generating schema', ids.length);
    const results = await pMapSeries(components, (component) => {
      longRunningLog.logProgress(component.id.toString());
      return this.schema.getSchema(component, undefined, true);
    });
    longRunningLog.end();
    return results;
  }
}
