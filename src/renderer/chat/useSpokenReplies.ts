import { useEffect, useMemo, useRef } from 'react';
import type { Message } from '../../shared/types';
import { api } from '../api';
import { SpeechPlayer, playClip, replyFinished } from './voice-playback';

/**
 * Replies of the chat on screen, read aloud as they finish while Voice is on.
 * Escape stops it, and so do switching chats and turning Voice off. A reply
 * that was already done when it arrived (a chat opened, a list loaded) is not
 * read: only one finishing now is.
 */
export function useSpokenReplies(options: { enabled: boolean; activeId: string | null; onError: (error: unknown) => void }): SpeechPlayer | null {
  const { enabled, activeId } = options;
  const onError = useRef(options.onError);
  onError.current = options.onError;
  const voice = api.voice;
  const player = useMemo(() => voice
    ? new SpeechPlayer({ speak: text => voice.speak(text), play: playClip, cancel: () => { void voice.stopSpeech?.().catch(() => {}); } }, error => onError.current(error))
    : null, [voice]);
  const live = useRef({ enabled, activeId });
  live.current = { enabled, activeId };
  useEffect(() => {
    if (!player) return;
    const seen = new Map<string, Message['status']>();
    const off = api.chat.onEvent(event => {
      const previous = seen.get(event.message.id);
      seen.set(event.message.id, event.message.status);
      const { enabled: on, activeId: shown } = live.current;
      if (on && event.conversationId === shown && replyFinished(previous, event.message)) void player.say(event.message.content);
    });
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && player.speaking) player.stop(); };
    window.addEventListener('keydown', escape, true);
    return () => { off(); window.removeEventListener('keydown', escape, true); player.stop(); };
  }, [player]);
  // Another chat on screen, or Voice off: silence.
  useEffect(() => { player?.stop(); }, [player, enabled, activeId]);
  return player;
}
