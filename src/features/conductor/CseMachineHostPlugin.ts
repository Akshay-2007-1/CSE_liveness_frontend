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
};

export type CseSerializedEnvFrame = {
  id: string;
  name: string;
  parentId: string | null;
  closureFrameId?: string;
  bindings: CseSerializedBinding[];
  isActive: boolean;
  /** true for every frame currently in context.runtime.environments[] (the call stack) */
  isOnCallStack?: boolean;
};

export type CseSnapshot = {
  stepIndex: number;
  control: CseSerializedInstruction[];
  stash: CseSerializedValue[];
  environments: CseSerializedEnvFrame[];
};

const CSE_CHANNEL = '__cse';

export class CseMachineHostPlugin implements IPlugin {
  readonly id = '__cse_host';
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
