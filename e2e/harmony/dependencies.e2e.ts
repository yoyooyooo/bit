import { IssuesClasses } from '@teambit/component-issues';
import { expect } from 'chai';
import { Helper, NpmCiRegistry, supportNpmCiRegistryTesting } from '@teambit/legacy.e2e-helper';

describe('dependencies', function () {
  let helper: Helper;
  this.timeout(0);
  before(() => {
    helper = new Helper();
  });
  after(() => {
    helper.scopeHelper.destroy();
  });
  (supportNpmCiRegistryTesting ? describe : describe.skip)('importing component without dependencies', () => {
    let npmCiRegistry: NpmCiRegistry;
    let afterExport: string;
    let beforeImport: string;
    before(async () => {
      helper = new Helper({ scopesOptions: { remoteScopeWithDot: true } });
      helper.scopeHelper.setWorkspaceWithRemoteScope();
      helper.workspaceJsonc.setupDefault();
      npmCiRegistry = new NpmCiRegistry(helper);
      await npmCiRegistry.init();
      npmCiRegistry.configureCiInPackageJsonHarmony();
      helper.fixtures.populateComponents(3);
      helper.command.tagAllComponents();
      helper.command.export();
      afterExport = helper.scopeHelper.cloneWorkspace();
      helper.scopeHelper.reInitWorkspace();
      npmCiRegistry.setResolver();
      beforeImport = helper.scopeHelper.cloneWorkspace();
    });
    after(() => {
      npmCiRegistry.destroy();
      helper = new Helper();
    });
    describe('import without --fetch-deps', () => {
      before(() => {
        helper.command.importComponent('comp1');
      });
      it('should bring only the imported component, not its dependencies', () => {
        const scope = helper.command.catScope();
        expect(scope).to.have.lengthOf(1);
      });
      it('bit status should not bring the dependencies during find-cycle process', () => {
        helper.command.status();
        const scope = helper.command.catScope();
        expect(scope).to.have.lengthOf(1);
      });
    });
    describe('import with --fetch-deps', () => {
      before(() => {
        helper.scopeHelper.getClonedWorkspace(beforeImport);
        helper.command.importComponent('comp1', '--fetch-deps');
      });
      it('should bring not only the imported component, but also its dependencies', () => {
        const scope = helper.command.catScope();
        expect(scope).to.have.lengthOf(3);
      });
    });
    describe('a dependency is both in the workspace and set with deps-set', () => {
      before(() => {
        helper.scopeHelper.getClonedWorkspace(afterExport);
        helper.fixtures.populateComponents(3, undefined, 'v2');
        helper.command.tagAllComponents();
        helper.command.export();

        helper.scopeHelper.reInitWorkspace();
        npmCiRegistry.setResolver();

        helper.command.importComponent('comp1', '-x');
        helper.command.importComponent('comp2', '-x');
        helper.command.install();

        const pkg = helper.general.getPackageNameByCompName('comp2');
        helper.command.dependenciesSet('comp1', `${pkg}@0.0.1`);
      });
      it('should show the dependency according to the deps-set and not the .bitmap', () => {
        const depsData = helper.command.showDependenciesData('comp1');
        const dep = depsData.find((d) => d.id === `${helper.scopes.remote}/comp2@0.0.1`);
        expect(dep?.version).to.equal('0.0.1');
      });
    });
  });
  describe('new dependent using exported dependency', () => {
    before(() => {
      helper.scopeHelper.setWorkspaceWithRemoteScope();
      helper.fixtures.populateComponents(2);
      helper.command.tagWithoutBuild('comp2');
      helper.command.export();
      helper.command.tagWithoutBuild();
      helper.command.export();
    });
    it('should convert the flattened edge of itself to an id with scope-name', () => {
      const comp = helper.command.catComponent('comp1@latest');
      const ref = comp.flattenedEdgesRef;
      const content = helper.command.catObject(ref);
      const json = JSON.parse(content);
      const firstEdge = json[0];
      if (Array.isArray(firstEdge)) {
        expect(firstEdge[0]).to.equal(`${helper.scopes.remote}/comp1@0.0.1`);
      } else {
        expect(json[0].source.scope).to.equal(helper.scopes.remote);
      }
    });
  });
  describe('ignoring a dependency using // @bit-ignore', () => {
    before(() => {
      helper.scopeHelper.setWorkspaceWithRemoteScope();
      helper.fixtures.populateComponentsTS(1);
      helper.fs.outputFile('comp1/index.ts', `import lodash from 'lodash';`);
      helper.command.addComponent('comp1');
    });
    it('without bit-ignore it should show an issue', () => {
      helper.command.expectStatusToHaveIssue(IssuesClasses.MissingPackagesDependenciesOnFs.name);
    });
    it('with bit-ignore it should not show an issue', () => {
      helper.fs.outputFile(
        'comp1/index.ts',
        `// @bit-ignore
import lodash from 'lodash';`
      );
      helper.command.expectStatusToNotHaveIssue(IssuesClasses.MissingPackagesDependenciesOnFs.name);
    });
    it('with bit-no-check it should ignore the entire file', () => {
      helper.fs.outputFile(
        'comp1/index.ts',
        `// @bit-no-check
import lodash from 'lodash';
import R from 'ramda';

const isPositive = require('is-positive');
`
      );
      helper.command.expectStatusToNotHaveIssue(IssuesClasses.MissingPackagesDependenciesOnFs.name);
    });
  });
  describe('a file-dependency exists with a different extension', () => {
    before(() => {
      helper.scopeHelper.setWorkspaceWithRemoteScope();
      helper.fs.outputFile('comp1/index.ts', `export const foo = 'foo';`);
      helper.fs.outputFile('comp1/bar.cjs', `import { foo } from './index.js';`);
      helper.command.addComponent('comp1');
    });
    it('should not show an issue of missing-files because the file could exist later in the dist', () => {
      helper.command.expectStatusToNotHaveIssue(IssuesClasses.MissingDependenciesOnFs.name);
    });
  });
  describe('changing files to be dev-files from env.jsonc', () => {
    before(() => {
      helper.scopeHelper.setWorkspaceWithRemoteScope();
      helper.env.setEmptyEnv();
      helper.fixtures.populateComponents(1, false);
      helper.fs.outputFile('comp1/some.content.tsx', `import lodash from 'lodash';`);
      helper.command.setEnv('comp1', 'empty-env');
      helper.command.install(undefined, { a: '' });
      helper.command.status(); // makes sure the comp is loaded and its deps are in the filesystem cache.
      helper.fs.outputFile(
        'empty-env/env.jsonc',
        JSON.stringify({ patterns: { contents: ['**/*.content.tsx'] } }, null, 2)
      );
    });
    // previously, it was needed to run `bit cc` to see lodash as dev. it was showing as a realtime dep.
    it('should clear all components caches and show the dep as a dev-dep', () => {
      const depsData = helper.command.getCompDepsDataFromData('comp1');
      const lodash = depsData.find((d) => d.id === 'lodash');
      expect(lodash).to.exist;
      expect(lodash?.lifecycle).to.equal('dev');
    });
  });
});
