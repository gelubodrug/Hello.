import { describe, expect, it } from 'vitest';
import { helloSystemPrompt } from '../src/main/chat/pi-instructions';
import type { AppSettings } from '../src/shared/types';

const settings = {
  endpointUrl: 'https://example.test/v1', model: 'm', apiKeySet: false,
  systemPrompt: 'Be helpful.', temperature: 0.7, connections: [],
} as AppSettings;

describe('what every turn is told before the user says anything', () => {
  it('asks for the work to be broken down, so the human never has to ask', () => {
    // opencode reached the end of a long build because its harness decomposed
    // first. Making the person write "break this into steps" in every prompt is
    // a bandage; the instruction belongs here, once, in both modes.
    for (const chatMode of ['chat', 'coder'] as const) {
      const prompt = helloSystemPrompt(settings, chatMode);
      expect(prompt).toContain('break it down BEFORE starting');
      expect(prompt).toContain('notebook_save');
      expect(prompt).toContain('never in one uninterrupted emission');
      // And that a step it could not check is said, not claimed.
      expect(prompt).toContain('limitation to state, not a claim to make');
    }
  });
});
