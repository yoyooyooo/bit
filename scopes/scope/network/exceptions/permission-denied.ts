import { BitError } from '@teambit/bit-error';
import { BASE_LEGACY_DOCS_DOMAIN } from '@teambit/legacy.constants';

export default class PermissionDenied extends BitError {
  scope: string;

  constructor(scope: string) {
    super(
      `error: permission to scope ${scope} was denied\nsee troubleshooting at https://${BASE_LEGACY_DOCS_DOMAIN}/setup-authentication#authentication-issues`
    );
  }
}
