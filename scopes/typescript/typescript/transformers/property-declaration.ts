import type { Node, PropertyDeclaration, PropertySignature } from 'typescript';
import { SyntaxKind, isPropertyDeclaration } from 'typescript';
import { VariableLikeSchema } from '@teambit/semantics.entities.semantic-schema';
import type { SchemaTransformer } from '../schema-transformer';
import type { SchemaExtractorContext } from '../schema-extractor-context';
import { parseTypeFromQuickInfo } from './utils/parse-type-from-quick-info';
import type { Identifier } from '../identifier';

export class PropertyDeclarationTransformer implements SchemaTransformer {
  predicate(node: Node) {
    return node.kind === SyntaxKind.PropertyDeclaration || node.kind === SyntaxKind.PropertySignature;
  }

  async getIdentifiers(): Promise<Identifier[]> {
    return [];
  }

  // [computedName]: string
  private isComputedProperty(node: PropertyDeclaration | PropertySignature) {
    return node.name.kind === SyntaxKind.ComputedPropertyName;
  }

  // @todo - handle arrow function objects
  async transform(node: PropertyDeclaration | PropertySignature, context: SchemaExtractorContext) {
    const name = node.name.getText();
    const info = this.isComputedProperty(node) ? undefined : await context.getQuickInfo(node.name);
    const displaySig = info?.body?.displayString || node.getText();
    const typeStr = parseTypeFromQuickInfo(info);
    const type = await context.resolveType(node, typeStr);
    const isOptional = Boolean(node.questionToken) || (isPropertyDeclaration(node) && Boolean(node.initializer));
    const doc = await context.jsDocToDocSchema(node);
    const defaultValue = isPropertyDeclaration(node) ? node.initializer?.getText() : undefined;
    return new VariableLikeSchema(context.getLocation(node), name, displaySig, type, isOptional, doc, defaultValue);
  }
}
