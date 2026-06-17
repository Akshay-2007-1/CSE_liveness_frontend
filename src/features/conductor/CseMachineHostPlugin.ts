/**
 * Re-export shim for the CSE machine host plugin.
 *
 * The plugin class and the language-agnostic snapshot protocol types now live in the shared
 * `@sourceacademy/web-cse-machine` package (backed by `@sourceacademy/common-cse-machine`).
 * This file is kept so existing intra-frontend imports of `../conductor/CseMachineHostPlugin`
 * continue to resolve; it adds no definitions of its own.
 */
export { CseMachineHostPlugin } from '@sourceacademy/web-cse-machine';
export type {
  CseSnapshot,
  CseSerializedValue,
  CseSerializedInstruction,
  CseSerializedBinding,
  CseSerializedEnvFrame,
  CseSnapshotMessage,
} from '@sourceacademy/web-cse-machine';
