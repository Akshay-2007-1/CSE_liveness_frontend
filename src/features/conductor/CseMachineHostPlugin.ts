import type { IChannel, IConduit, IPlugin } from '@sourceacademy/conductor/conduit';

export type CseSerializedValue = {
  displayValue: string;
  label: string;
  tag?: string;
  metadata?: unknown;
};

export type CseSerializedInstruction = {
  displayText: string;
  tag?: string;
  metadata?: unknown;
};

export type CseSerializedBinding = {
  name: string;
  value: CseSerializedValue;
  isConst?: boolean;
};

export type CseSerializedEnvFrame = {
  id: string;
  name: string;
  parentId: string | null;
  closureFrameId?: string;
  bindings: CseSerializedBinding[];
  /** Closures/arrays in the frame's heap that are not bound to any name (anonymous heap objects). */
  heapObjects?: CseSerializedValue[];
  isActive: boolean;
  /** true for every frame currently in context.runtime.environments[] (the call stack) */
  isOnCallStack?: boolean;
};

export type CseSnapshot = {
  stepIndex: number;
  control: CseSerializedInstruction[];
  stash: CseSerializedValue[];
  environments: CseSerializedEnvFrame[];
  /**
   * 1-based source line of the node most recently evaluated at this step
   * (i.e. context.runtime.nodes[0]). Mirrors how the non-conductor CSE machine
   * derives the blue "current line" highlight in updateInspector. Undefined when
   * there is no current node (→ clears the highlight).
   */
  currentLine?: number;
};

const CSE_CHANNEL = '__cse';

export class CseMachineHostPlugin implements IPlugin {
  readonly name = '__cse_host';
  receiveSnapshots?: (snapshots: CseSnapshot[]) => void;

  static readonly channelAttach = [CSE_CHANNEL];
  constructor(_conduit: IConduit, channels: IChannel<any>[]) {
    const cseChannel = channels.find(ch => ch.name === CSE_CHANNEL);
    cseChannel?.subscribe((msg: any) => {
      if (msg?.type === 'snapshots' && Array.isArray(msg.snapshots)) {
        this.receiveSnapshots?.(msg.snapshots as CseSnapshot[]);
      }
    });
  }
}
