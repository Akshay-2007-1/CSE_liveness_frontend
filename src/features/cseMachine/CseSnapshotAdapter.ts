/**
 * CseSnapshotAdapter — translates language-agnostic CseSnapshot (from the Conductor __cse
 * channel) into the fake js-slang-compatible objects that Layout.setContext() consumes.
 *
 * Key insight: js-slang's type guards use duck-typing (typeof, instanceof checks, field
 * presence). By constructing objects that pass those guards, we can reuse the entire Source
 * CSE Machine visualization for any language that sends CseSnapshot.
 *
 * Closures: isClosure() accepts any function with the six 'closureFields'. We create a real
 * JS function and attach those fields — no prototype surgery needed.
 * Primitives: actual JS number/string/boolean — pass typeof checks naturally.
 * Arrays: real JS arrays with .id and .environment own properties — pass isDataArray() check.
 */
import { EnvTree } from 'js-slang/dist/createContext';
import Heap from 'js-slang/dist/cse-machine/heap';
import type { Control, Stash } from 'js-slang/dist/cse-machine/interpreter';
import { InstrType } from 'js-slang/dist/cse-machine/types';
import type { Environment } from 'js-slang/dist/types';

import type { CseSerializedValue, CseSnapshot } from '../conductor/CseMachineHostPlugin';
import { Config } from './CseMachineConfig';

// Global counter so every fake closure gets a unique id regardless of which env it was defined in.
// Layout.values memoizes FnValues by closure.id, so two closures with the same id would share
// one circle — using a counter prevents that collision.
let _closureSeq = 0;

// Minimal stub AST node — getParamsText/getBodyText read .functionName and data.toString()
// from the fake function, not from this node, so a stub is sufficient.
const STUB_BODY = { type: 'BlockStatement', body: [] };

function makeStubNode(paramNames: string[]) {
  return {
    type: 'ArrowFunctionExpression',
    params: paramNames.map(p => ({ type: 'Identifier', name: p })),
    body: STUB_BODY,
    loc: undefined,
  };
}

function toJsValue(
  v: CseSerializedValue,
  envMap: Map<string, Environment>,
  closureCache: Map<string, unknown>,
  listCache: Map<number, unknown>,
): unknown {
  const label = v.label.toLowerCase();

  if (label === 'int' || label === 'float' || label === 'number') {
    const n = parseFloat(v.displayValue);
    return isNaN(n) ? 0 : n;
  }
  if (label === 'bool' || label === 'boolean') {
    return v.displayValue === 'True' || v.displayValue === 'true';
  }
  if (label === 'str' || label === 'string') {
    return v.displayValue.replace(/^["']|["']$/g, '');
  }
  if (label === 'nonetype' || label === 'none' || label === 'null') {
    return null;
  }

  if (label === 'list') {
    const meta = v.metadata as any;
    const listId: number = meta?.id ?? 0;
    const envId: string = meta?.envId ?? '';
    const elements: CseSerializedValue[] = meta?.elements ?? [];

    // Same Python list object (same stable id) must map to the same JS array so
    // Layout.values memoization produces one DataArray box, not one per binding.
    if (listCache.has(listId)) return listCache.get(listId);

    // Build a real JS array — isDataArray() checks Array.isArray + own 'id' + own 'environment'.
    const arr: any = elements.map(el => toJsValue(el, envMap, closureCache, listCache));
    arr.id = `list_${listId}`;
    arr.environment = envMap.get(envId) ?? null;

    listCache.set(listId, arr);
    return arr;
  }

  if (/closure|function|lambda|method/.test(label)) {
    const meta = v.metadata as any;
    const closureEnvId: string = meta?.closureFrameId ?? '';
    const params: string[] = meta?.params ?? [];
    const funcName: string = meta?.funcName ?? v.displayValue.split('(')[0] ?? 'fn';

    // Same logical Python closure (same name + defining env + params) must map to the exact same
    // JS object so Layout.values memoization (keyed by object identity) returns one FnValue circle.
    // Without this, each binding that holds the same closure creates a separate JS object → two
    // FnValue instances, the one in the outer frame staying at (0,0) forever.
    const cacheKey = `${funcName}@${closureEnvId}@${params.join(',')}`;
    if (closureCache.has(cacheKey)) return closureCache.get(cacheKey);

    const fakeFn: any = function SnapshotClosure() {};
    fakeFn.id = `snap_${++_closureSeq}_${closureEnvId}`;
    fakeFn.environment = envMap.get(closureEnvId) ?? null;
    fakeFn.functionName = `${funcName}(${params.join(', ')}) => {}`;
    fakeFn.predefined = false;
    fakeFn.node = makeStubNode(params);
    fakeFn.originalNode = fakeFn.node;
    fakeFn.toString = () => `function ${funcName}(${params.join(', ')}) { [Python] }`;
    closureCache.set(cacheKey, fakeFn);
    return fakeFn;
  }

  // Fallback: render as a string primitive (shows as PrimitiveValue)
  return v.displayValue;
}

/** Build a duck-typed stack that satisfies the IStack interface used by ControlStack/StashStack. */
function makeFakeStack<T>(items: T[]) {
  const storage = [...items];
  const stack = {
    push: (...newItems: T[]) => { storage.push(...newItems); },
    pop: () => storage.pop(),
    peek: () => (storage.length > 0 ? storage[storage.length - 1] : undefined),
    size: () => storage.length,
    isEmpty: () => storage.length === 0,
    getStack: () => [...storage],
    some: (pred: (v: T) => boolean) => storage.some(pred),
    setTo: (other: any) => { storage.length = 0; storage.push(...other.getStack()); },
    // Control-specific extras
    canAvoidEnvInstr: () => true,
    copy: () => makeFakeStack([...storage]),
  };
  return stack;
}

export type SnapshotAdapterResult = {
  envTree: EnvTree;
  fakeControl: Control;
  fakeStash: Stash;
};

export function buildFakeEnvTreeFromSnapshot(snapshot: CseSnapshot): SnapshotAdapterResult {
  // py-slang has three top-level envs: global (tail=null), prelude (tail=null, built-ins),
  // and programEnvironment (tail=prelude). We hide the prelude frame — it's noisy (full of
  // built-in functions) and Source CSE Machine also hides it (via removePreludeEnv).
  // Instead we reparent any child of prelude directly to global, matching Source's behaviour.
  const rawFrames = snapshot.environments;
  const globalFrame = rawFrames.find(f => f.name === 'global' && f.parentId === null);
  const preludeFrame = rawFrames.find(f => f.name === 'prelude' && f.parentId === null);
  const frames = (() => {
    if (!globalFrame) return rawFrames;
    if (!preludeFrame) {
      // No prelude env serialized (ch1: misc+math preludes are empty strings, so no prelude env
      // is ever pushed onto the call stack). Any orphaned top-level frame — i.e. a frame other
      // than global that also has parentId=null because its tail was undefined — must be
      // reparented to global so EnvTree.insert doesn't silently drop it.
      return rawFrames.map(f =>
        f !== globalFrame && f.parentId === null ? { ...f, parentId: globalFrame.id } : f,
      );
    }
    return rawFrames
      .filter(f => f !== preludeFrame)
      .map(f =>
        f.parentId === preludeFrame.id ? { ...f, parentId: globalFrame.id } : f,
      );
  })();

  // One cache per snapshot render: same logical Python closure/list → same JS object,
  // so Layout.values memoization (keyed by object identity) produces one canvas box.
  const closureCache = new Map<string, unknown>();
  const listCache = new Map<number, unknown>();

  // ── Pass 1: create bare Environment objects ─────────────────────────────
  const envMap = new Map<string, Environment>();
  for (const f of frames) {
    // Frame.tsx accesses entries[0][0] for 'global' env without guarding for empty heads.
    // py-slang's global env has no head bindings (builtins live in nativeStorage), so we
    // pre-populate the same sentinel Source uses to keep Frame's constructor from crashing.
    const head: Record<string, unknown> =
      f.name === 'global' ? { [Config.GlobalFrameDefaultText]: Symbol() } : {};
    const env = {
      id: f.id,
      name: f.name,
      head,
      tail: null as Environment | null,
      heap: new Heap(),
    } as unknown as Environment;
    envMap.set(f.id, env);
  }

  // ── Pass 2: wire tail (parent) links ────────────────────────────────────
  for (const f of frames) {
    if (f.parentId) {
      const parent = envMap.get(f.parentId);
      if (parent) (envMap.get(f.id) as any).tail = parent;
    }
  }

  // ── Pass 3a: populate non-closure values ────────────────────────────────
  // Done first so the envMap is complete when closures look up their environments.
  for (const f of frames) {
    const env = envMap.get(f.id)!;
    for (const b of f.bindings) {
      if (!/closure|function|lambda|method/i.test(b.value.label)) {
        (env.head as any)[b.name] = toJsValue(b.value, envMap, closureCache, listCache);
      }
    }
  }

  // ── Pass 3b: populate closure values ────────────────────────────────────
  for (const f of frames) {
    const env = envMap.get(f.id)!;
    for (const b of f.bindings) {
      if (/closure|function|lambda|method/i.test(b.value.label)) {
        const val = toJsValue(b.value, envMap, closureCache, listCache);
        (env.head as any)[b.name] = val;
        // If this closure was defined in a different frame than where it is bound
        // (e.g. a lambda returned from a function), add it to the defining frame's heap.
        // Source CSE Machine's getUnreferencedObjects() will then create a dummy binding
        // in that dead frame, making isMainReference() return true and positioning the
        // FnValue circle correctly beside the dead frame instead of at (0,0).
        const definingEnv = (val as any)?.environment;
        if (definingEnv && definingEnv !== env) {
          definingEnv.heap.add(val);
        }
      }
    }
  }

  // ── Pass 4: build EnvTree using the actual EnvTree class ────────────────
  // EnvTree.insert() uses object identity as the map key, so we must insert
  // environments in parent-before-child order.
  const envTree = new EnvTree();
  const rootFrames = frames.filter(f => !f.parentId);
  for (const f of rootFrames) {
    envTree.insert(envMap.get(f.id)!);
  }

  const inserted = new Set(rootFrames.map(f => f.id));
  const queue = frames.filter(f => f.parentId).map(f => f.id);
  let qi = 0;
  let guard = frames.length * 2;
  while (qi < queue.length && guard-- > 0) {
    const id = queue[qi++];
    const frame = frames.find(f => f.id === id)!;
    if (frame.parentId && inserted.has(frame.parentId)) {
      envTree.insert(envMap.get(id)!);
      inserted.add(id);
    } else {
      queue.push(id);
    }
  }

  // ── Build fake Control (top-first in snapshot → reverse for stack order) ─
  const controlItems = [...snapshot.control].reverse().map(instr => {
    // ENVIRONMENT instructions: build a fake EnvInstr so the renderer draws an
    // arrow from the control item to the frame it will restore.
    // py-slang serializes these with metadata.envId; js-slang InstrType is "Environment".
    const meta = instr.metadata as any;
    if (instr.displayText.toLowerCase() === 'environment' && meta?.envId) {
      const targetEnv = envMap.get(meta.envId as string);
      // Only emit ENV item if the target frame was actually serialized. If it's missing
      // (shouldn't happen with correct py-slang serialization) fall through to plain text.
      if (targetEnv) {
        // srcNode stub prevents ControlStack from crashing when it tries node.loc
        // on an instruction whose srcNode would otherwise be undefined.
        return { instrType: InstrType.ENVIRONMENT, env: targetEnv, srcNode: { loc: undefined } };
      }
    }
    // All other items: fake Identifier node — isNode() returns true and
    // getControlItemComponent falls through to the default astToString case.
    // Attach loc if the runner sent line info so ControlStack can highlight source.
    const loc = meta?.startLine !== undefined
      ? { start: { line: meta.startLine }, end: { line: meta.endLine ?? meta.startLine } }
      : undefined;
    return { type: 'Identifier' as const, name: instr.displayText, loc };
  });

  // py-slang now emits real ENVIRONMENT instructions (pointing to the caller's env) for
  // every function call. Those are picked up by collectRootEnvIds Root 3, keeping all
  // call-stack frames alive without any synthetic injection here.
  const fakeControl = makeFakeStack(controlItems) as unknown as Control;

  // ── Build fake Stash ─────────────────────────────────────────────────────
  const stashItems = snapshot.stash.map(sv => toJsValue(sv, envMap, closureCache, listCache));
  const fakeStash = makeFakeStack(stashItems) as unknown as Stash;

  return { envTree, fakeControl, fakeStash };
}
