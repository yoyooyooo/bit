import type { DependencyDetector, FileContext } from '@teambit/dependency-resolver';
import { compileSync } from '@teambit/mdx.compilers.mdx-transpiler';

export class MDXDependencyDetector implements DependencyDetector {
  constructor(private supportedExtensions: string[]) {}

  isSupported(context: FileContext): boolean {
    return this.supportedExtensions.includes(context.ext);
  }

  detect(source: string): string[] {
    const output = compileSync(source);
    const imports = output.getImportSpecifiers();
    if (!imports) return [];
    const files: string[] = imports.map((importSpec) => {
      return importSpec.fromModule;
    });

    return files;
  }
}
