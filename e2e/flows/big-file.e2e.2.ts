import chai, { expect } from 'chai';
import fs from 'fs-extra';
import * as path from 'path';

import { Helper } from '@teambit/legacy.e2e-helper';

chai.use(require('chai-fs'));

describe('big text file', function () {
  this.timeout(0);
  let helper: Helper;
  before(() => {
    helper = new Helper();
  });
  after(() => {
    helper.scopeHelper.destroy();
  });
  describe('Windows format (\\r\\n)', () => {
    let tagOutput;
    before(() => {
      helper.scopeHelper.setWorkspaceWithRemoteScope();
      const bigFilePath = path.join(__dirname, '..', 'fixtures', 'big-text-file-fixture.txt');
      const bigFileContent = fs.readFileSync(bigFilePath).toString();
      const windowsFormatContent = bigFileContent.replace(/\r\n|\r|\n/g, '\r\n');
      fs.outputFileSync(path.join(helper.scopes.localPath, 'bar', 'big-text-file.txt'), windowsFormatContent);
      helper.fixtures.createComponentBarFoo();
      helper.command.addComponent('bar', { i: 'bar/text', m: 'bar/foo.js' });
      tagOutput = helper.command.tagWithoutBuild('bar/text');
    });
    it('tagging the component should not throw any error', () => {
      expect(tagOutput).to.have.string('1 component(s) tagged');
    });
    describe('exporting and importing the component', () => {
      let importOutput;
      before(() => {
        helper.command.export();
        helper.scopeHelper.reInitWorkspace();
        helper.scopeHelper.addRemoteScope();
        importOutput = helper.command.importComponent('bar/text');
      });
      it('should work with no errors', () => {
        expect(importOutput).to.have.string('successfully imported one component');
      });
      it('should import the big file', () => {
        const filePath = path.join(helper.scopes.localPath, helper.scopes.remote, 'bar/text/big-text-file.txt');
        expect(filePath).to.be.a.file().and.not.empty;
      });
    });
  });
});
