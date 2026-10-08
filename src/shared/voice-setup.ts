export type VoiceStepId = 'server' | 'model' | 'speech';
export interface VoiceSetupStep {
  id: VoiceStepId;
  title: string;
  state: 'pending' | 'working' | 'done' | 'error';
  detail: string;
  received?: number;
  total?: number;
}
export interface VoiceSetupStatus {
  state: 'idle' | 'preparing' | 'ready' | 'error';
  supported: boolean;
  installed: boolean;
  downloadBytes: number;
  steps: VoiceSetupStep[];
  error?: string;
}
