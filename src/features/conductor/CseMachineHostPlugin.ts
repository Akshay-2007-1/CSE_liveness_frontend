/**
 * Re-export shim for the CSE machine host plugin.
 *
 * The plugin class and the language-agnostic snapshot protocol types now live in the shared
 * `@sourceacademy/web-cse-machine` package (backed by `@sourceacademy/common-cse-machine`).
 * This file is kept so existing intra-frontend imports of `../conductor/CseMachineHostPlugin`
 * continue to resolve.
 *
 * `CseMachineHostPlugin` is abstract in the package; this shim provides a concrete subclass
 * with a reassignable `receiveSnapshots` so callers can wire in a callback after construction.
 */
import {
  CseMachineHostPlugin as _CseMachineHostPluginBase,
  type CseSnapshot,
} from '@sourceacademy/web-cse-machine';

export class CseMachineHostPlugin extends _CseMachineHostPluginBase {
  receiveSnapshots: (snapshots: CseSnapshot[]) => void = () => {};
}

export type {
  CseSnapshot,
  CseSerializedValue,
  CseSerializedInstruction,
  CseSerializedBinding,
  CseSerializedEnvFrame,
  CseSnapshotMessage,
} from '@sourceacademy/web-cse-machine';
