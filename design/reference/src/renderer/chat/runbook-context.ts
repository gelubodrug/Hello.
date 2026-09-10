import type { RunbookContextStatus } from '../../shared/types';

/**
 * Turns one turn's `RunbookContextStatus` into the line the transcript shows.
 *
 * Main decides what reached the model and reports it per turn; this only
 * words it. Every case is said out loud — including the ones where nothing
 * was sent — because the alternative is what the UX scout flagged: the only
 * way to tell whether the runbook was used is to guess from the answer.
 */
export interface RunbookContextSummary {
  /** Leading label in the turn's step trail. */
  label: string;
  /** Short trailing notes, in the agent-step flag anatomy. */
  flags: string[];
  /** The whole state as a sentence — the accessible name and the tooltip. */
  description: string;
  /** True when runbook text actually reached the model. */
  included: boolean;
}

const NUMBER = new Intl.NumberFormat('en-US');

function entries(count: number): string {
  return `${NUMBER.format(count)} ${count === 1 ? 'entry' : 'entries'}`;
}

function chars(count: number): string {
  return `${NUMBER.format(count)} ${count === 1 ? 'char' : 'chars'}`;
}

export function runbookContextSummary(status: RunbookContextStatus): RunbookContextSummary {
  switch (status.reason) {
    case 'available': {
      return {
        label: 'Chat runbook · available on demand',
        flags: [],
        description:
          `This chat has ${entries(status.entryCount)}. Their contents were not injected into ` +
          'the prompt; they remain available through read-only runbook access.',
        included: false,
      };
    }
    case 'included':
    case 'budgetTruncated': {
      const truncated = status.reason === 'budgetTruncated';
      const flags: string[] = [];
      if (truncated) {
        flags.push(
          status.omittedEntryCount === 1
            ? '1 entry trimmed to fit'
            : `${NUMBER.format(status.omittedEntryCount)} entries trimmed to fit`,
        );
      }

      const budget = truncated
        ? ` ${
            status.omittedEntryCount === 1
              ? '1 entry was'
              : `${status.omittedEntryCount} entries were`
          } trimmed or left out to stay inside the ${NUMBER.format(status.maxChars)}-character budget.`
        : '';

      return {
        label: `Chat runbook · ${entries(status.entryCount)}, ${chars(status.charCount)}`,
        flags,
        description:
          `The chat runbook went to the model for this turn: ${entries(status.entryCount)}, ` +
          `${NUMBER.format(status.charCount)} of ${NUMBER.format(status.maxChars)} characters.` +
          budget,
        included: true,
      };
    }

    case 'emptyRunbook':
      return {
        label: 'Chat runbook · empty, nothing sent',
        flags: [],
        description: 'No runbook went to the model: this chat has no runbook entries yet.',
        included: false,
      };

    case 'noConversation':
    default:
      return {
        label: 'Chat runbook · no chat, nothing sent',
        flags: [],
        description: 'No runbook went to the model because there is no chat for this turn.',
        included: false,
      };
  }
}
