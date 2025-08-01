import fs from 'fs-extra';
import glob from 'glob';
import * as path from 'path';

import type CommandHelper from './e2e-command-helper';
import type ScopeHelper from './e2e-scope-helper';
import type ScopesData from './e2e-scopes';

export default class GitHelper {
  scopes: ScopesData;
  command: CommandHelper;
  scopeHelper: ScopeHelper;
  constructor(scopes: ScopesData, commandHelper: CommandHelper, scopeHelper: ScopeHelper) {
    this.scopes = scopes;
    this.command = commandHelper;
    this.scopeHelper = scopeHelper;
  }
  writeGitIgnore(list: string[]) {
    const gitIgnorePath = path.join(this.scopes.localPath, '.gitignore');
    return fs.writeFileSync(gitIgnorePath, list.join('\n'));
  }
  writeToGitHook(hookName: string, content: string) {
    const hookPath = path.join(this.scopes.localPath, '.git', 'hooks', hookName);
    return fs.outputFileSync(hookPath, content);
  }
  initNewGitRepo(setTestUser = false) {
    this.command.runCmd('git init');
    if (setTestUser) {
      this.addGitConfig('user.name', 'Test User');
      this.addGitConfig('user.email', 'test@example.com');
    }
  }

  addGitConfig(key: string, val: string, location = 'local') {
    return this.command.runCmd(`git config --${location} ${key} ${val}`);
  }

  unsetGitConfig(key: string, location = 'local') {
    return this.command.runCmd(`git config --unset --${location} ${key}`);
  }
  mimicGitCloneLocalProject(cloneWithComponentsFiles = true) {
    fs.removeSync(path.join(this.scopes.localPath, '.bit'));
    if (!cloneWithComponentsFiles) fs.removeSync(path.join(this.scopes.localPath, 'components'));
    // delete all node-modules from all directories
    const directories = glob.sync(path.normalize('**/'), { cwd: this.scopes.localPath, dot: true });
    directories.forEach((dir) => {
      if (dir.includes('node_modules')) {
        fs.removeSync(path.join(this.scopes.localPath, dir));
      }
    });
    this.command.init();
  }
  mimicGitCloneLocalProjectHarmony(cloneWithComponentsFiles = true) {
    fs.removeSync(path.join(this.scopes.localPath, '.bit'));
    if (!cloneWithComponentsFiles) fs.removeSync(path.join(this.scopes.localPath, 'components'));
    // delete all node-modules from all directories
    const directories = glob.sync(path.normalize('**/'), { cwd: this.scopes.localPath, dot: true });
    directories.forEach((dir) => {
      if (dir.includes('node_modules')) {
        fs.removeSync(path.join(this.scopes.localPath, dir));
      }
    });
    this.command.init();
  }
}
