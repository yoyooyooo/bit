import { expect } from 'chai';
import { Helper } from '@teambit/legacy.e2e-helper';

describe('workspace config (workspace.jsonc)', function () {
  this.timeout(0);
  let helper: Helper;
  before(() => {
    helper = new Helper();
  });
  after(() => {
    helper.scopeHelper.destroy();
  });
  describe('adding a non-component key', () => {
    before(() => {
      helper.scopeHelper.setWorkspaceWithRemoteScope();
      helper.workspaceJsonc.addKeyVal('non-comp', {});
    });
    it('any command should throw a descriptive error', () => {
      expect(() => helper.command.status()).to.throw(
        `unable to parse the component-id "non-comp" from the workspace.jsonc file`
      );
    });
  });
  describe('adding a non-existing component to a variant', () => {
    before(() => {
      helper.scopeHelper.reInitWorkspace();
      helper.fixtures.populateComponents(1);
      helper.workspaceJsonc.addToVariant('*', 'teambit.harmony/non-exist', {});
    });
    it('any command should throw a ComponentNotFound error with specific suggestions for the workspace.jsonc file', () => {
      expect(() => helper.command.status()).to.throw(`your workspace.jsonc has this component-id set`);
    });
  });
});
