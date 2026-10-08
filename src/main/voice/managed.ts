import { chmod, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { VoiceServer, VoiceSettings, VoiceSpeech } from '../../shared/types';
import type { VoiceSetupStatus, VoiceStepId } from '../../shared/voice-setup';
import { atomicWriteFileSync, atomicWriteTarget } from '../atomic-write';
import { KOKORO_MODEL, KOKORO_ROOT, KOKORO_VOICES, voiceArtifacts, WHISPER_MODEL, type VoiceArtifact } from './manifest';
import { VoiceModelStore } from './model-store';
import { WhisperSupervisor } from './supervisor';
import { voiceCommand } from './process';
import { loopbackBase, SPEECH_BYTE_LIMIT, SPEECH_TEXT_LIMIT } from './speak';
import { isSpeechServer, isWhisperServer } from './servers';

export class ManagedVoice {
  private readonly files: VoiceModelStore;
  private readonly lifetime = new AbortController();
  private operation?: AbortController;
  private speech = new AbortController();
  private pending?: Promise<VoiceSetupStatus>;
  private supervisor?: WhisperSupervisor;
  private stt?: string;
  private tts?: string;
  private ttsPaths?: { executable: string; library: string; model: string };
  private snapshot: VoiceSetupStatus;
  private lastEmit = 0;
  constructor(private readonly options: {
    root: string; settings: () => VoiceSettings | undefined;
    discover: () => Promise<VoiceServer[]>;
    changed: (status: VoiceSetupStatus) => void;
  }) {
    this.files = new VoiceModelStore(options.root);
    let bytes = 0; let supported = true;
    try { const assets = voiceArtifacts(); bytes = assets.server.bytes + WHISPER_MODEL.bytes + assets.speech.bytes + KOKORO_MODEL.bytes; }
    catch { supported = false; }
    let installed = false;
    try { atomicWriteTarget(this.receipt, 'refuse'); installed = existsSync(this.receipt); } catch { /* surfaced at prepare */ }
    this.snapshot = { state: 'idle', supported, installed, downloadBytes: bytes, steps: this.steps() };
  }
  private get receipt(): string { return join(this.options.root, 'ready-v1.json'); }
  private steps(): VoiceSetupStatus['steps'] {
    return [
      { id: 'server', title: 'Whisper engine', state: 'pending', detail: 'Install the local speech-to-text server.' },
      { id: 'model', title: 'Whisper model', state: 'pending', detail: 'Download large-v3-turbo · 1.62 GB.' },
      { id: 'speech', title: 'Spoken replies', state: 'pending', detail: 'Install Kokoro and its speech engine · about 155 MB.' },
    ];
  }
  status(): VoiceSetupStatus { return structuredClone(this.snapshot); }
  private emit(force = true): void {
    if (!force && Date.now() - this.lastEmit < 150) return;
    this.lastEmit = Date.now(); this.options.changed(this.status());
  }
  private step(id: VoiceStepId, detail: string, state: VoiceSetupStatus['steps'][number]['state'] = 'working'): void {
    const step = this.snapshot.steps.find(item => item.id === id)!;
    Object.assign(step, { state, detail, received: undefined, total: undefined }); this.emit();
  }
  /** Only the button passes download=true. Restart/first use may restore local
   * installed components but can never authorize another remote download.
   */
  prepare(download = true): Promise<VoiceSetupStatus> {
    if (this.pending) return this.pending;
    if (this.lifetime.signal.aborted) return Promise.reject(new Error('Hello. is closing.'));
    const operation = new AbortController(); this.operation = operation;
    const signal = AbortSignal.any([operation.signal, this.lifetime.signal]);
    this.pending = this.install(download, signal).finally(() => { this.pending = undefined; this.operation = undefined; });
    return this.pending;
  }
  cancel(): void {
    if (this.operation) this.operation.abort();
    else if (this.supervisor) {
      this.supervisor.dispose(); this.supervisor = undefined;
      this.snapshot.state = 'error'; this.snapshot.error = 'Voice startup cancelled. Click to start it again.';
      this.step('server', this.snapshot.error, 'error');
    }
  }
  private async asset(asset: VoiceArtifact, id: VoiceStepId, download: boolean, signal: AbortSignal): Promise<string> {
    this.step(id, `Checking ${asset.name}…`);
    return this.files.download(asset, signal, (received, total) => {
      const step = this.snapshot.steps.find(item => item.id === id)!;
      Object.assign(step, { received, total, detail: received === total ? `Checking ${asset.name}…` : `Downloading ${asset.name}…` }); this.emit(false);
    }, download);
  }
  private async archive(asset: VoiceArtifact, id: VoiceStepId, download: boolean, signal: AbortSignal): Promise<string> {
    await this.asset(asset, id, download, signal); this.step(id, `Installing ${asset.name}…`);
    return this.files.unpack(asset, signal);
  }
  private async install(download: boolean, signal: AbortSignal): Promise<VoiceSetupStatus> {
    this.snapshot = { ...this.snapshot, state: 'preparing', error: undefined, steps: this.steps() }; this.emit();
    try {
      const assets = voiceArtifacts(); await this.files.directory();
      const settings = this.options.settings(); const found = await this.options.discover(); signal.throwIfAborted();
      // A configured endpoint is the person's choice. A found server is never
      // installed over, loaded with another model, supervised, or killed.
      this.stt = settings?.sttEndpointUrl ? loopbackBase(settings.sttEndpointUrl)
        : found.find(server => server.kind === 'whisper.cpp' && server.baseUrl !== this.supervisor?.url)?.baseUrl;
      this.tts = settings?.ttsEndpointUrl ? loopbackBase(settings.ttsEndpointUrl) : found.find(server => server.kind === 'speech')?.baseUrl;
      let executable: string | undefined; let model: string | undefined;
      if (this.stt) {
        this.step('server', 'Checking your speech-to-text server…');
        if (!await isWhisperServer(this.stt, '', fetch)) {
          const response = await fetch(`${this.stt}/v1/models`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
          const models = response.ok ? await response.json() as { data?: unknown } : null;
          if (!settings?.sttModel || !Array.isArray(models?.data)) throw new Error('Your speech-to-text server is unavailable or has no selected model. Check Advanced settings.');
        }
        this.step('server', `Using your server at ${this.stt}`, 'done');
        this.step('model', 'Using the model on your server; nothing to download.', 'done');
      } else {
        const folder = await this.archive(assets.server, 'server', download, signal);
        executable = join(folder, assets.serverEntry); atomicWriteTarget(executable, 'refuse'); await chmod(executable, 0o700);
        this.step('server', 'Whisper engine installed.', 'done');
        model = await this.asset(WHISPER_MODEL, 'model', download, signal);
        this.step('model', 'Whisper model verified and installed.', 'done');
      }
      if (this.tts) {
        this.step('speech', 'Checking your speech server…');
        if (!await isSpeechServer(this.tts, fetch)) throw new Error('Your speech server is unavailable. Check Advanced settings.');
        this.step('speech', `Using your speech server at ${this.tts}`, 'done');
      }
      else {
        const runtime = await this.archive(assets.speech, 'speech', download, signal);
        const modelRoot = await this.archive(KOKORO_MODEL, 'speech', download, signal);
        const executable = join(runtime, assets.speechRoot, 'bin', 'sherpa-onnx-offline-tts');
        atomicWriteTarget(executable, 'refuse'); await chmod(executable, 0o700);
        this.ttsPaths = { executable, library: join(runtime, assets.speechRoot, 'lib'), model: join(modelRoot, KOKORO_ROOT) };
        for (const name of ['model.int8.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt']) {
          const path = join(this.ttsPaths.model, name); atomicWriteTarget(path, 'refuse');
          if (!(await lstat(path)).isFile()) throw new Error('A Kokoro component is missing. Try again.');
        }
        this.step('speech', 'Checking Kokoro with a short local speech sample…');
        await this.speak('Voice is ready.', 'af_heart', signal);
        this.step('speech', 'Kokoro installed. Replies use the local af_heart voice.', 'done');
      }
      signal.throwIfAborted();
      if (executable && model) {
        if (!this.supervisor) this.supervisor = new WhisperSupervisor({ executable, model, cwd: this.options.root,
          changed: (state, detail) => {
            this.step('server', detail, state === 'ready' ? 'done' : state === 'error' ? 'error' : 'working');
            if (state === 'error') { this.snapshot.state = 'error'; this.snapshot.error = detail; }
            else { this.snapshot.state = state === 'ready' ? 'ready' : 'preparing'; this.snapshot.error = undefined; }
            this.emit();
          },
        });
        const abort = () => this.supervisor?.dispose(); signal.addEventListener('abort', abort, { once: true });
        try { await this.supervisor.start(download); }
        catch (error) { this.supervisor.dispose(); this.supervisor = undefined; throw error; }
        finally { signal.removeEventListener('abort', abort); }
      }
      signal.throwIfAborted();
      atomicWriteFileSync(this.receipt, JSON.stringify({ version: 1 }), { symlinks: 'refuse' });
      this.snapshot.installed = true; this.snapshot.state = 'ready'; this.snapshot.error = undefined; this.emit();
      return this.status();
    } catch (error) {
      this.ttsPaths = undefined;
      const detail = signal.aborted ? 'Installation cancelled. Completed downloads are kept; click to continue.'
        : error instanceof Error ? error.message : 'Voice could not be installed. Try again.';
      const current = this.snapshot.steps.find(step => step.state === 'working');
      if (current) { current.state = 'error'; current.detail = detail; }
      this.snapshot.state = 'error'; this.snapshot.error = detail; this.emit(); throw new Error(detail);
    }
  }
  async translationEndpoint(): Promise<string> {
    const configured = this.options.settings()?.sttEndpointUrl;
    if (configured) return loopbackBase(configured);
    if (this.supervisor) return this.supervisor.start();
    if (this.stt) return this.stt;
    const found = (await this.options.discover()).find(server => server.kind === 'whisper.cpp');
    if (found) return found.baseUrl;
    if (!this.snapshot.installed) throw new Error('Install Voice in Settings before using the microphone.');
    await this.prepare(false);
    const restored = this.supervisor as WhisperSupervisor | undefined;
    return restored ? restored.start() : this.stt!;
  }
  cancelSpeech(): void { this.speech.abort(); this.speech = new AbortController(); }
  get speechSignal(): AbortSignal { return AbortSignal.any([this.speech.signal, this.lifetime.signal]); }
  async speechEndpoint(): Promise<string | null> {
    const configured = this.options.settings()?.ttsEndpointUrl;
    if (configured) return loopbackBase(configured);
    if (this.tts) return this.tts;
    if (this.ttsPaths) return null;
    const found = (await this.options.discover()).find(server => server.kind === 'speech');
    if (found) return found.baseUrl;
    if (!this.snapshot.installed) throw new Error('Install Voice in Settings to hear replies.');
    await this.prepare(false); return this.tts ?? null;
  }
  async speak(text: string, voice = 'af_heart', operationSignal?: AbortSignal): Promise<VoiceSpeech> {
    if (!this.ttsPaths) throw new Error('Install Voice in Settings to hear replies.');
    if (!text.trim() || text.length > SPEECH_TEXT_LIMIT) throw new Error('That speech chunk is empty or too long.');
    const sid = KOKORO_VOICES.indexOf(voice);
    if (sid < 0) throw new Error('Choose an English Kokoro voice such as af_heart in Settings › Voice.');
    const { executable, model, library } = this.ttsPaths;
    atomicWriteTarget(executable, 'refuse'); atomicWriteTarget(model, 'refuse'); atomicWriteTarget(library, 'refuse');
    const signal = operationSignal ? AbortSignal.any([operationSignal, this.lifetime.signal]) : this.speechSignal;
    const folder = await this.files.directory(join(this.options.root, 'speech-tmp'));
    const temporary = await mkdtemp(join(folder, 'chunk-')); const output = join(temporary, 'speech.wav');
    try {
      await voiceCommand(executable, [
        `--kokoro-model=${join(model, 'model.int8.onnx')}`, `--kokoro-voices=${join(model, 'voices.bin')}`,
        `--kokoro-tokens=${join(model, 'tokens.txt')}`, `--kokoro-data-dir=${join(model, 'espeak-ng-data')}`,
        `--kokoro-lexicon=${join(model, 'lexicon-us-en.txt')}`, '--kokoro-lang=en-us', '--num-threads=2', '--debug=0', '--print-args=false', `--sid=${sid}`, `--output-filename=${output}`, '--', text,
      ], { signal, cwd: temporary, library });
      atomicWriteTarget(output, 'refuse'); const stat = await lstat(output);
      if (!stat.isFile() || stat.size < 44 || stat.size > SPEECH_BYTE_LIMIT) throw new Error('Kokoro returned an invalid audio clip.');
      signal.throwIfAborted(); const audio = await readFile(output);
      if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Kokoro returned an invalid WAV clip.');
      return { audio: new Uint8Array(audio), mime: 'audio/wav' };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  dispose(): void { this.lifetime.abort(); this.operation?.abort(); this.cancelSpeech(); this.supervisor?.dispose(); }
}
