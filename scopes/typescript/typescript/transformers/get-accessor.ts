import type { Node, GetAccessorDeclaration } from 'typescript';
import ts from 'typescript';
import { GetAccessorSchema } from '@teambit/semantics.entities.semantic-schema';
import type { SchemaTransformer } from '../schema-transformer';
import type { SchemaExtractorContext } from '../schema-extractor-context';
import { parseTypeFromQuickInfo } from './utils/parse-type-from-quick-info';
import type { Identifier } from '../identifier';

export class GetAccessorTransformer implements SchemaTransformer {
  predicate(node: Node) {
    return node.kind === ts.SyntaxKind.GetAccessor;
  }

  async getIdentifiers(): Promise<Identifier[]> {
    return [];
  }

  async transform(node: GetAccessorDeclaration, context: SchemaExtractorContext) {
    const info = await context.getQuickInfo(node.name);
    const displaySig = info?.body?.displayString || '';
    const typeStr = parseTypeFromQuickInfo(info);
    const type = await context.resolveType(node, typeStr);
    return new GetAccessorSchema(context.getLocation(node), node.name.getText(), type, displaySig);
  }
}
