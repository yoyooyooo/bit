import chalk from 'chalk';
import type { ComponentID } from '@teambit/component-id';
import type { SnapsDistance } from '@teambit/component.snap-distance';
import type { IssuesList } from '@teambit/component-issues';
import {
  IMPORT_PENDING_MSG,
  statusFailureMsg,
  statusWarningsMsg,
  statusInvalidComponentsMsg,
  statusWorkspaceIsCleanMsg,
  BASE_DOCS_DOMAIN,
} from '@teambit/legacy.constants';
import { compact, groupBy, partition } from 'lodash';
import { isHash } from '@teambit/component-version';
import type { StatusResult } from './status.main.runtime';

const TROUBLESHOOTING_MESSAGE = chalk.yellow(
  `learn more about Bit components: ${BASE_DOCS_DOMAIN}reference/components/component-anatomy`
);

export type StatusFormatterOptions = {
  strict?: boolean;
  verbose?: boolean;
  warnings?: boolean;
  failOnError?: boolean;
};

export function formatStatusOutput(
  statusResult: StatusResult,
  options: StatusFormatterOptions = {}
): { data: string; code: number } {
  const { strict = false, verbose = false, warnings = false, failOnError = false } = options;

  const {
    newComponents,
    modifiedComponents,
    stagedComponents,
    componentsWithIssues,
    importPendingComponents,
    autoTagPendingComponents,
    invalidComponents,
    locallySoftRemoved,
    remotelySoftRemoved,
    outdatedComponents,
    mergePendingComponents,
    componentsDuringMergeState,
    softTaggedComponents,
    snappedComponents,
    pendingUpdatesFromMain,
    localOnly,
    updatesFromForked,
    unavailableOnMain,
    currentLaneId,
    forkedLaneId,
    workspaceIssues,
  } = statusResult;

  // If there is problem with at least one component we want to show a link to the
  // troubleshooting doc
  let showTroubleshootingLink = false;

  function format(
    id: ComponentID,
    showIssues = false,
    message?: string,
    localVersions?: string[],
    showSoftTagMsg = true
  ): string {
    const idWithIssues = componentsWithIssues.find((c) => c.id.isEqual(id));
    const isSoftTagged = Boolean(softTaggedComponents.find((softTaggedId) => softTaggedId.isEqual(id)));
    const getStatusText = () => {
      if (message) return message;
      if (idWithIssues) {
        return idWithIssues.issues.hasTagBlockerIssues() ? statusFailureMsg : statusWarningsMsg;
      }
      return 'ok';
    };
    const getColor = () => {
      if (message) return 'yellow';
      if (idWithIssues) return idWithIssues.issues.hasTagBlockerIssues() ? 'red' : 'yellow';
      return 'green';
    };
    const messageStatusText = getStatusText();
    const messageStatusTextWithSoftTag =
      isSoftTagged && showSoftTagMsg ? `${messageStatusText} (soft-tagged)` : messageStatusText;
    const messageStatus = chalk[getColor()](messageStatusTextWithSoftTag);
    let idFormatted = chalk.white('     > ') + chalk.cyan(id.toStringWithoutVersion());

    if (!showIssues && !localVersions) {
      return `${idFormatted} ... ${messageStatus}`;
    }
    if (localVersions) {
      if (verbose) {
        idFormatted += `. versions: ${localVersions.join(', ')}`;
      } else {
        const [snaps, tags] = partition(localVersions, (version) => isHash(version));
        const tagsStr = tags.length ? `versions: ${tags.join(', ')}` : '';
        const snapsStr = snaps.length ? `${snaps.length} snap(s)` : '';
        idFormatted += `. `;
        idFormatted += tagsStr && snapsStr ? `${tagsStr}. and ${snapsStr}` : tagsStr || snapsStr;
      }
    }
    idFormatted += ' ... ';
    if (showIssues && idWithIssues) {
      showTroubleshootingLink = true;
      const issuesTxt = idWithIssues.issues.hasTagBlockerIssues() ? statusFailureMsg : statusWarningsMsg;
      const issuesColor = idWithIssues.issues.hasTagBlockerIssues() ? 'red' : 'yellow';
      return `${idFormatted} ${chalk[issuesColor](issuesTxt)}${formatIssues(idWithIssues.issues)}`;
    }
    return `${idFormatted}${messageStatus}`;
  }

  function formatCategory(title: string, description: string, compsOutput: string[]) {
    if (!compsOutput.length) return '';
    const titleOutput = chalk.underline.white(`${title} (${compsOutput.length})`);
    const descOutput = description ? `${description}\n` : '';
    return [titleOutput, descOutput, ...compsOutput].join('\n');
  }

  const importPendingWarning = importPendingComponents.length ? chalk.yellow(`${IMPORT_PENDING_MSG}.\n`) : '';

  const newCompFormatted = newComponents.map((c) => format(c));
  const { missing, nonMissing } = groupBy(newCompFormatted, (component) => {
    return component.includes(statusFailureMsg) ? 'missing' : 'nonMissing';
  });

  const outdatedTitle = 'pending updates';
  const outdatedDesc =
    '(use "bit checkout head" to merge changes)\n(use "bit diff [component_id] [new_version]" to compare changes)\n(use "bit log [component_id]" to list all available versions)';
  const outdatedComps = outdatedComponents.map((component) => {
    const latest =
      component.latestVersion && component.latestVersion !== component.headVersion
        ? ` latest: ${component.latestVersion}`
        : '';
    return `    > ${chalk.cyan(component.id.toStringWithoutVersion())} current: ${component.id.version} head: ${
      component.headVersion
    }${latest}`;
  });
  const outdatedStr = formatCategory(outdatedTitle, outdatedDesc, outdatedComps);

  const pendingMergeTitle = 'pending merge';
  const pendingMergeDesc = `(use "bit reset" to discard local tags/snaps, and bit checkout head to re-merge with the remote.
alternatively, to keep local tags/snaps history, use "bit merge [component-id]")`;
  const pendingMergeComps = mergePendingComponents.map((component) => {
    return `    > ${chalk.cyan(component.id.toString())} local and remote have diverged and have ${
      component.divergeData.snapsOnSourceOnly.length
    } (source) and ${component.divergeData.snapsOnTargetOnly.length} (target) uncommon snaps respectively`;
  });

  const pendingMergeStr = formatCategory(pendingMergeTitle, pendingMergeDesc, pendingMergeComps);

  const compDuringMergeTitle = 'components in merge state';
  const compDuringMergeDesc = `(use "bit snap/tag [--unmerged]" to complete the merge process.
to cancel the merge operation, use either "bit lane merge-abort" (for prior "bit lane merge" command)
or use "bit merge [component-id] --abort" (for prior "bit merge" command)`;
  const compDuringMergeComps = componentsDuringMergeState.map((c) => format(c));

  const compDuringMergeStr = formatCategory(compDuringMergeTitle, compDuringMergeDesc, compDuringMergeComps);

  const newComponentDescription = '\n(use "bit snap/tag" to lock a version with all your changes)\n';
  const newComponentsTitle = newComponents.length
    ? chalk.underline.white('new components') + newComponentDescription
    : '';

  const newComponentsOutput = [newComponentsTitle, ...(nonMissing || []), ...(missing || [])].join('\n');

  const modifiedDesc = '(use "bit diff" to compare changes)';
  const modifiedComponentOutput = formatCategory(
    'modified components',
    modifiedDesc,
    modifiedComponents.map((c) => format(c))
  );

  const autoTagPendingTitle = 'components pending auto-tag (when their modified dependencies are tagged)';
  const autoTagPendingOutput = formatCategory(
    autoTagPendingTitle,
    '',
    autoTagPendingComponents.map((c) => format(c))
  );

  const componentsWithIssuesToPrint = componentsWithIssues.filter((c) => c.issues.hasTagBlockerIssues() || warnings);
  const compWithIssuesDesc = '(fix the issues according to the suggested solution)';
  const compWithIssuesOutput = formatCategory(
    'components with issues',
    compWithIssuesDesc,
    componentsWithIssuesToPrint.map((c) => format(c.id, true)).sort()
  );

  const invalidDesc = 'these components failed to load';
  const invalidComps = invalidComponents.map((c) => format(c.id, false, getInvalidComponentLabel(c.error))).sort();
  const invalidComponentOutput = formatCategory(statusInvalidComponentsMsg, invalidDesc, invalidComps);

  const locallySoftRemovedDesc =
    '(tag/snap and export the components to update the deletion to the remote. to undo deletion, run "bit recover")';
  const locallySoftRemovedOutput = formatCategory(
    'soft-removed components locally',
    locallySoftRemovedDesc,
    locallySoftRemoved.map((c) => format(c)).sort()
  );

  const remotelySoftRemovedDesc =
    '(use "bit remove" to remove them from the workspace. use "bit recover" to undo the deletion)';
  const remotelySoftRemovedOutput = formatCategory(
    'components deleted on the remote',
    remotelySoftRemovedDesc,
    remotelySoftRemoved.map((c) => format(c)).sort()
  );

  const stagedDesc = '(use "bit export" to push these component versions to the remote scope)';
  const stagedComps = stagedComponents.map((c) => format(c.id, false, undefined, c.versions));
  const stagedComponentsOutput = formatCategory('staged components', stagedDesc, stagedComps);

  const localOnlyDesc = '(these components are excluded from tag/snap/export commands)';
  const localOnlyComps = localOnly.map((c) => format(c)).sort();
  const localOnlyComponentsOutput = formatCategory('local-only components', localOnlyDesc, localOnlyComps);

  const softTaggedDesc = '(use "bit tag --persist" to complete the tag)';
  const softTaggedComps = softTaggedComponents.map((id) => format(id, false, undefined, undefined, false));
  const softTaggedComponentsOutput = formatCategory('soft-tagged components', softTaggedDesc, softTaggedComps);

  const snappedDesc = '(use "bit tag" or "bit tag --snapped" to lock a semver version)';
  const snappedComponentsOutput = formatCategory(
    'snapped components (tag pending)',
    snappedDesc,
    snappedComponents.map((c) => format(c))
  );

  const unavailableOnMainDesc = '(use "bit checkout head" to make them available)';
  const unavailableOnMainOutput = formatCategory(
    'components unavailable on main',
    unavailableOnMainDesc,
    unavailableOnMain.map((c) => format(c))
  );

  const getUpdateFromMsg = (divergeData: SnapsDistance, from = 'main'): string => {
    if (divergeData.err) return divergeData.err.message;
    let msg = `${from} is ahead by ${divergeData.snapsOnTargetOnly.length || 0} snaps`;
    if (divergeData.snapsOnSourceOnly && verbose) {
      msg += ` (diverged since ${divergeData.commonSnapBeforeDiverge?.toShortString()})`;
    }
    return msg;
  };

  const updatesFromMainDesc = '(use "bit lane merge main" to merge the changes)';
  const pendingUpdatesFromMainIds = pendingUpdatesFromMain.map((c) =>
    format(c.id, false, getUpdateFromMsg(c.divergeData))
  );
  const updatesFromMainOutput = formatCategory(
    'pending updates from main',
    updatesFromMainDesc,
    pendingUpdatesFromMainIds
  );

  let updatesFromForkedOutput = '';
  if (forkedLaneId) {
    const updatesFromForkedDesc = `(use "bit lane merge ${forkedLaneId.toString()}" to merge the changes
use "bit fetch ${forkedLaneId.toString()} --lanes" to update ${forkedLaneId.name} locally)`;
    const pendingUpdatesFromForkedIds = updatesFromForked.map((c) =>
      format(c.id, false, getUpdateFromMsg(c.divergeData, forkedLaneId.name))
    );
    updatesFromForkedOutput = formatCategory(
      `updates from ${forkedLaneId.name}`,
      updatesFromForkedDesc,
      pendingUpdatesFromForkedIds
    );
  }

  const getLaneStr = () => {
    if (currentLaneId.isDefault()) return '';
    const prefix = `\n\ncurrent lane ${chalk.bold(currentLaneId.toString())}`;
    return prefix;
  };

  const getWorkspaceIssuesOutput = () => {
    if (!workspaceIssues.length) return '';
    const title = chalk.underline.white('workspace issues');
    const issues = workspaceIssues.join('\n');
    return `\n\n${title}\n${issues}`;
  };

  const troubleshootingStr = showTroubleshootingLink ? `\n${TROUBLESHOOTING_MESSAGE}` : '';
  const wereWarningsFilteredOut = componentsWithIssuesToPrint.length < componentsWithIssues.length;
  const showWarningsStr = wereWarningsFilteredOut
    ? `\n${chalk.yellow('to view the warnings, use --warnings flag.')}`
    : '';

  const statusMsg =
    importPendingWarning +
    compact([
      outdatedStr,
      pendingMergeStr,
      updatesFromMainOutput,
      updatesFromForkedOutput,
      compDuringMergeStr,
      localOnlyComponentsOutput,
      newComponentsOutput,
      modifiedComponentOutput,
      snappedComponentsOutput,
      stagedComponentsOutput,
      softTaggedComponentsOutput,
      unavailableOnMainOutput,
      autoTagPendingOutput,
      compWithIssuesOutput,
      invalidComponentOutput,
      locallySoftRemovedOutput,
      remotelySoftRemovedOutput,
    ]).join(chalk.underline('\n                         \n') + chalk.white('\n')) +
    showWarningsStr +
    troubleshootingStr;

  const results = (statusMsg || chalk.yellow(statusWorkspaceIsCleanMsg)) + getWorkspaceIssuesOutput() + getLaneStr();

  // Determine exit code based on flags
  let exitCode = 0;
  if (strict && componentsWithIssues.length > 0) {
    // Strict mode: fail on any issues (both errors and warnings)
    exitCode = 1;
  } else if (failOnError) {
    // Fail only on tag blocker issues (errors), not warnings
    const hasTagBlockerIssues = componentsWithIssues.some((c) => c.issues.hasTagBlockerIssues());
    if (hasTagBlockerIssues) {
      exitCode = 1;
    }
  }

  return {
    data: results,
    code: exitCode,
  };
}

export function formatIssues(issues: IssuesList) {
  return `       ${issues?.outputForCLI()}\n`;
}

function getInvalidComponentLabel(error: Error) {
  switch (error.name) {
    case 'MainFileRemoved':
      return 'main-file was removed (use "bit add" with "--main" and "--id" flags to add a main file)';
    case 'ComponentNotFoundInPath':
      return 'component files were deleted (use "bit remove [component_id]") or moved (use "bit move <old-dir> <new-dir>"). to restore use "bit checkout reset [component_id]"';
    case 'ExtensionFileNotFound':
      // @ts-ignore error.path is set for ExtensionFileNotFound
      return `extension file is missing at ${chalk.bold(error.path)}`;
    case 'ComponentsPendingImport':
      return 'component objects are missing from the scope (use "bit import [component_id] --objects" to get them back)';
    case 'NoComponentDir':
      return `component files were added individually without root directory (invalid on Harmony. re-add as a directory or use "bit move --component" to help with the move)`;
    case 'IgnoredDirectory':
      return `component files or directory were ignored (probably by .gitignore)`;
    case 'NoCommonSnap':
      return `component history is unrelated to main (merge main with --resolve-unrelated flag)`;
    default:
      return error.name;
  }
}
