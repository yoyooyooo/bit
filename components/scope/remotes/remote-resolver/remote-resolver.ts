import retry from 'async-retry';
import { GraphQLClient, gql } from 'graphql-request';
import { InvalidScopeName, isValidScopeName, InvalidScopeNameFromRemote } from '@teambit/legacy-bit-id';
import { getConfig } from '@teambit/config-store';
import { CFG_HUB_DOMAIN_KEY, DEFAULT_HUB_DOMAIN, CFG_USER_TOKEN_KEY, getSymphonyUrl } from '@teambit/legacy.constants';
import type { Scope } from '@teambit/legacy.scope';
import { getAuthHeader, getFetcherWithAgent } from '@teambit/scope.network';
import { logger } from '@teambit/legacy.logger';
import { ScopeNotFoundOrDenied } from '../exceptions/scope-not-found-or-denied';

const hubDomain = getConfig(CFG_HUB_DOMAIN_KEY) || DEFAULT_HUB_DOMAIN;
const symphonyUrl = getSymphonyUrl();

type ResolverFunction = (scopeName: string, thisScopeName?: string, token?: string) => Promise<string>;

const scopeCache = {};

const SCOPE_GET = gql`
  query GET_SCOPE($id: String!) {
    getScope(id: $id) {
      isLegacy
      apis {
        url
      }
    }
  }
`;

// comment this out once on production
async function getScope(name: string) {
  if (scopeCache[name]) return scopeCache[name];
  const token = getConfig(CFG_USER_TOKEN_KEY);
  const headers = token ? getAuthHeader(token) : {};
  const graphQlUrl = `${symphonyUrl}/graphql`;
  const graphQlFetcher = await getFetcherWithAgent(graphQlUrl);
  const client = new GraphQLClient(graphQlUrl, { headers, fetch: graphQlFetcher });

  try {
    const res = await retry(
      async () => {
        const _res = await client.request(SCOPE_GET, {
          id: name,
        });
        return _res;
      },
      {
        retries: 3,
        onRetry: (e: any) => {
          logger.debug(`failed to getScope with error: ${e?.message || ''}`);
        },
      }
    );
    scopeCache[name] = res;
    return res;
  } catch (err: any) {
    logger.error('getScope has failed', err);
    const msg: string =
      err?.response?.errors?.[0].message ||
      err?.message ||
      "unknown error. please use the '--log' flag for the full error.";
    const errorCode = err?.response?.errors?.[0].ERR_CODE;
    if (msg === 'access denied') {
      throw new ScopeNotFoundOrDenied(name);
    }
    if (errorCode === 'InvalidScopeID') {
      if (isValidScopeName(name)) {
        throw new InvalidScopeNameFromRemote(name);
      }
      throw new InvalidScopeName(name);
    }
    throw new Error(`${name}: ${msg}`);
  }
}

const hubResolver = async (scopeName) => {
  // check if has harmony
  const scope = await getScope(scopeName);
  const harmonyScope = scope && scope.getScope && scope.getScope.isLegacy === false;

  if (harmonyScope) {
    return scope.getScope.apis.url;
  }
  const hubPrefix = `ssh://bit@${hubDomain}:`;
  return hubPrefix + scopeName;
};

const remoteResolver = (scopeName: string, thisScope?: Scope): Promise<string> => {
  const token = getConfig(CFG_USER_TOKEN_KEY);
  const resolverPath = thisScope?.scopeJson.resolverPath;
  let resolverFunction: ResolverFunction;
  if (!resolverPath) {
    // use the default resolver
    resolverFunction = hubResolver;
  } else {
    // use the resolver described in the scopeJson
    // eslint-disable-next-line import/no-dynamic-require, global-require
    resolverFunction = require(resolverPath);
  }

  return resolverFunction(scopeName, thisScope ? thisScope.name : undefined, token); // should return promise<string>
};

export default remoteResolver;
