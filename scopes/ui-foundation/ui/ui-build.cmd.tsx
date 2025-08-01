import type { Command } from '@teambit/cli';
import { UnknownBuildError } from './exceptions';

import type { UiMain } from './ui.main.runtime';

export class UIBuildCmd implements Command {
  name = 'ui-build [type]';
  description = 'build production assets for deployment.';
  alias = 'c';
  group = 'run-serve';
  options = [];
  private = true;

  constructor(
    /**
     * access to the extension instance.
     */
    private ui: UiMain
  ) {}

  async report([type]: [string]): Promise<string> {
    // teambit.workspace/variants should be the one to take care of component patterns.
    const stats = await this.ui.build(type);
    if (!stats) throw new UnknownBuildError();
    return stats.toString();
  }
}
