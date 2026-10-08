import { release } from 'node:os';

/** Publisher release metadata checked 2026-10-09. No floating release URLs. */
export interface VoiceArtifact { name: string; url: string; bytes: number; sha256: string; }
export const WHISPER_MODEL: VoiceArtifact = {
  name: 'ggml-large-v3-turbo.bin', bytes: 1624555275,
  sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo.bin',
};
export const KOKORO_MODEL: VoiceArtifact = {
  name: 'kokoro-int8-multi-lang-v1_0.tar.bz2', bytes: 132303094,
  sha256: '4c3052abaa60943a341f193888cf6abd68787dae6ab8ae5c925a706caa247e4e',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2',
};
export function voiceArtifacts(arch = process.arch, platform = process.platform, kernelMajor = Number(release().split('.')[0])): { server: VoiceArtifact; speech: VoiceArtifact; serverEntry: string; speechRoot: string } {
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch) || kernelMajor < 23) throw new Error('Automatic Voice installation requires macOS 14 or later on Apple Silicon or Intel.');
  const arm = arch === 'arm64';
  const serverEntry = `whisper-server-darwin-${arch}`;
  const speechRoot = `sherpa-onnx-v1.13.8-osx-${arch}-shared`;
  return {
    serverEntry, speechRoot,
    server: { name: `${serverEntry}.zip`, url: `https://github.com/sjoerdteunisse/whisper.cpp/releases/download/v1.0.0/${serverEntry}.zip`,
      bytes: arm ? 1215954 : 1256575,
      sha256: arm ? '77a8dd22611de8436f7a3af85e1c439f9b0d72c40559f4fb7e585d6167fc9d20' : 'ac03619b88268c880ffc5e872fe428719df1a12bc6d8fadeecc902d91f49ec0a' },
    speech: { name: `${speechRoot}.tar.bz2`, url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/${speechRoot}.tar.bz2`,
      bytes: arm ? 20314448 : 22846038,
      sha256: arm ? 'b10e5c7e2c30ea03de9c442655d14860d9edc475c6251d58a8f5f06e913a1d56' : '54aad64acee9d2d596535a6080d6f22602a720af5460e1d50461b1e1b06bee40' },
  };
}
export const KOKORO_ROOT = 'kokoro-int8-multi-lang-v1_0';
export const KOKORO_VOICES = ['af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa', 'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily', 'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis'];
