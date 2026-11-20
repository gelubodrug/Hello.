import { describe, expect, it } from 'vitest';
import { browserManual, helloSystemPrompt, notebookManual, runtimeGuidance, workersManual } from '../src/main/chat/pi-instructions';
import type { AppSettings } from '../src/shared/types';

const settings = {
  endpointUrl: 'https://example.test/v1', model: 'm', apiKeySet: false,
  systemPrompt: 'Be helpful.', temperature: 0.7, connections: [],
} as AppSettings;

const extensions = { skills: [], mcp: [] };

describe('what every turn is told before the user says anything', () => {
  it('asks for the work to be broken down when Plan is on, so the human never has to ask', () => {
    // opencode reached the end of a long build because its harness decomposed
    // first. Making the person write "break this into steps" in every prompt is
    // a bandage; the instruction belongs here, once, in both modes.
    {
      const prompt = helloSystemPrompt(settings, extensions, true);
      expect(prompt).toContain('break it down BEFORE starting');
      // Saving the plan is the notebook group's rule, loaded with it.
      expect(notebookManual({ runbook: true, tasks: true }, true)).toContain('notebook_save');
      expect(prompt).toContain('never in one uninterrupted emission');
      // And that a step it could not check is said, not claimed.
      expect(prompt).toContain('limitation to state, not a claim to make');
    }
  });

  it('tells a model behind the gate to execute a work order, not reopen it, and says nothing of it otherwise', () => {
    // The gate asked before the order was written (user, 18.11: assume the execution, never the problem).
    const gated = helloSystemPrompt(settings, extensions, false, { runbook: false, tasks: false }, true);
    expect(gated).toContain('WORK ORDER');
    expect(gated).toContain('Execute the order as written, in one pass');
    expect(gated).toContain('never at the level of the problem');
    expect(helloSystemPrompt(settings, extensions, false, { runbook: false, tasks: false }, false)).not.toContain('WORK ORDER');
    expect(helloSystemPrompt(settings)).not.toContain('WORK ORDER');
  });

  it('asks for no plan at all when Plan is off, which is the default', () => {
    {
      const prompt = helloSystemPrompt(settings);
      expect(prompt).not.toContain('plan_write');
      expect(prompt).not.toContain('break it down BEFORE starting');
      expect(prompt).toContain('This chat has Plan off');
      expect(prompt).toContain('Do not write a plan, a checklist');
      // Saying a job is too big to track without one stays allowed.
      expect(prompt).toContain('the human turns Plans on in the chat’s notebook');
      // What is true either way stays either way.
      expect(prompt).toContain('never in one uninterrupted emission');
      expect(prompt).toContain('limitation to state, not a claim to make');
    }
  });
});

// The panes beside the chat are other agents: it can see them, prompt them,
// and they speak back on their own (user, 18.09).
describe('what a chat is told about the panes beside it', () => {
  it('names the three things it can do, and that a worker answers by itself', () => {
    const prompt = workersManual();
    expect(prompt).toContain('worker_list');
    expect(prompt).toContain('worker_read');
    expect(prompt).toContain('worker_say');
    expect(prompt).toContain('arrives as your next turn');
    expect(prompt).toContain('worker_answer');
  });

  it('forbids the loop and names the key for a pane stuck in a dialog', () => {
    const prompt = workersManual();
    expect(prompt).toContain('NEVER read a pane in a loop');
    expect(prompt).toContain('reaches this chat by itself, as a new turn');
    expect(prompt).toContain('worker_wait once');
    expect(prompt).toContain('worker_key');
    expect(prompt).toContain('carries the reporting duty with it');
  });

  it('keeps sent, running and done as three claims with three proofs', () => {
    const prompt = workersManual();
    expect(prompt).toContain('Three separate claims');
    expect(prompt).toContain('NOT SENT means the words are still sitting in that prompt box');
    expect(prompt).toContain('from the fact that you called a tool');
  });

  it('says whose access a worker holds, and that its words are not findings', () => {
    const prompt = workersManual();
    expect(prompt).toContain('spends its own model credits');
    expect(prompt).toContain('needs their approval');
    expect(prompt).toContain('never proof that what it says happened did happen');
    expect(prompt).toContain('never repeat its claims as your own findings');
  });
});

// A page the human switched off is not mentioned either: a model told about
// Tasks it cannot reach asks the human to turn it on (user, 20.09).
describe('what a chat is told about pages that are gone', () => {
  // The prompt says the pages exist; the notebook group carries their rules.
  const pages = (runbook: boolean, tasks: boolean, planning = true) =>
    `${helloSystemPrompt(settings, extensions, planning, { runbook, tasks })}\n${notebookManual({ runbook, tasks }, planning)}`;

  it('describes every section while it is there', () => {
    const prompt = pages(true, true);
    expect(prompt).toContain('persistent shared notebook: Runbook, Tasks and Plans');
    expect(prompt).toContain('notebook_save');
    expect(prompt).toContain('Your plan lives in the notebook’s Plans');
    // Plans follows Plan.
    expect(pages(true, true, false)).toContain('persistent shared notebook: Runbook and Tasks.');
    expect(pages(true, true, false)).not.toContain('Your plan lives');
  });

  it('says nothing about a page that is off', () => {
    const withoutTasks = pages(true, false);
    expect(withoutTasks).toContain('Runbook');
    expect(withoutTasks).not.toContain('Tasks');
    expect(withoutTasks).not.toContain('notebook_save');

    const withoutRunbook = pages(false, true);
    expect(withoutRunbook).toContain('Tasks is the shared work plan');
    expect(withoutRunbook).not.toContain('Runbook');
  });

  it('speaks of the plan alone when Plans is the only section on', () => {
    const manual = notebookManual({ runbook: false, tasks: false }, true);
    expect(manual).toContain('Your plan lives in the notebook’s Plans');
    expect(manual).not.toContain('When the user refers to');
    expect(manual).not.toMatch(/refers to ,/);
  });

  it('leaves the whole subject out when every section is off', () => {
    const neither = pages(false, false, false);
    expect(neither).not.toContain('Runbook');
    expect(neither).not.toContain('Tasks');
    expect(neither).not.toContain('notebook_list');
    // What the chat itself does is untouched.
    expect(neither).toContain('This chat always has a folder to work in');
  });
});

// A model told the browser "has no download function" reaches for a shell
// that has no session (user, 23.09). The prompt says where a file goes.
describe('what a chat is told about saving a file from a page', () => {
  it('names browser_download and forbids the shell for a file behind a login', () => {
    {
      const prompt = browserManual();
      expect(prompt).toContain('use browser_download on that tab');
      expect(prompt).toContain('never curl or wget a file behind a login');
      expect(prompt).toContain('Full allows click/type/scroll/pointer/download');
    }
  });
});

// A tab is a current Chromium on 127.0.0.1, so a generated page can compute
// in it. What it cannot do is thread: no cross-origin isolation, no SAB.
describe('what a chat is told about computing inside a tab', () => {
  it('names navigator.gpu, the CPU fallback and the missing SharedArrayBuffer', () => {
    const prompt = browserManual();
    expect(prompt).toContain('navigator.gpu');
    expect(prompt).toContain('keep a CPU path');
    expect(prompt).toContain('SharedArrayBuffer is not available');
    expect(prompt).toContain('never a CDN you chose');
  });
});

// A click by ref, real, then read again: what agent-browser taught (user,
// 24.09: "nu nimerește butoanele — trebuie să mai implementăm ceva?").
describe('what a chat is told about clicking in a page', () => {
  it('names the ref, the real click, the read-again rule and keeps the pointer for canvas', () => {
    const prompt = browserManual();
    expect(prompt).toContain('browser_click ref: "e12" is the sure way to click one');
    expect(prompt).toContain('then read the page again');
    expect(prompt).toContain('Never aim browser_pointer at a control browser_read lists');
    expect(prompt).toContain('browser_press sends Enter, Escape, Tab or an arrow');
    expect(prompt).toContain('browser_wait waits for words, a control, an address or the load');
    expect(prompt).toContain('browser_screenshot refs: true draws the refs on the picture');
    expect(prompt).toContain('Controls inside a frame');
    expect(prompt).toContain('When a dialog is open, browser_read lists only its controls');
    expect(prompt).toContain('never invent a ref and never guess coordinates for it');
    expect(prompt).toContain('Give ref and label together; if the ref no longer holds, the words decide');
  });
});

// Tools are prompt-context driven (user, 29.09): the prompt carries the rule
// and the core; each area's manual arrives with its tool group.
describe('what a chat is told about its tools', () => {
  it('says tools are loaded by area with tools_find, and names the areas', () => {
    {
      const prompt = helloSystemPrompt(settings);
      expect(prompt).toContain('Tools are prompt-context driven');
      expect(prompt).toContain('call tools_find with that group first');
      for (const group of ['loads browser', 'load workers', 'Runbook and Tasks load notebook']) expect(prompt).toContain(group);
      expect(prompt).toContain('web_search and fetch_url');
    }
    // One way of working (user, 17.11): the shell and the file tools are in view, in a folder the chat always
    // has; no mode is named, and the browser is said to load by itself when the request is that work.
    const one = helloSystemPrompt(settings);
    // Three measured wastes, each with its line (user, 17.11): a 12,618-character script re-sent to mend one
    // line, six checking scripts each re-reading 29,425 rows, and a script named inspect.py that Python loaded
    // in place of the module openpyxl imports — the same name chosen in two separate runs.
    expect(one).toContain('mended with file_edit after that');
    expect(one).toContain('never re-sent whole through the shell');
    expect(one).toContain('Never name a script after a module');
    expect(one).toContain('inspect.py, json.py, csv.py, time.py, types.py');
    expect(one).toContain('ONE pass at the end, in one script');
    expect(one).toContain('bash, the file tools for the chat\u2019s folder');
    expect(one).toContain('This chat always has a folder to work in');
    expect(one).toContain('Hello loads it by itself when a request names a page, a site, a link or a tab');
    expect(one).not.toMatch(/Coder mode|Chat mode|loads coding/);
    // Planning keeps the trigger to read the human's plan first.
    expect(helloSystemPrompt(settings, extensions, true)).toContain('Before planning repository work, load notebook and read Tasks.');
    expect(helloSystemPrompt(settings, extensions, false)).not.toContain('Before planning repository work');
  });

  it('keeps each area’s manual out of the prompt', () => {
    const prompt = helloSystemPrompt(settings);
    expect(prompt).not.toContain('NEVER read a pane in a loop');
    expect(prompt).not.toContain('browser_click ref: "e12"');
    expect(prompt).not.toContain('Use notebook_save with kind tasks');
    expect(prompt.length).toBeLessThan(helloSystemPrompt(settings).length + 1);
    expect(prompt.length + workersManual().length + browserManual().length).toBeGreaterThan(prompt.length * 2);
  });
});


// Qwen in kapitsa on this Mac said it ran "in the cloud" (user, 12.11).
describe('what a chat is told about where it runs', () => {
  it('names the model and the server, and says a server on this Mac is not a cloud', () => {
    const local = runtimeGuidance({ endpointUrl: 'http://localhost:8000/v1', model: 'qwen3.8-flash-next' }, 'kapitsa · 8000');
    expect(local).toContain('You are the model qwen3.8-flash-next, served by kapitsa · 8000 at http://localhost:8000/v1');
    expect(local).toContain('generated on this computer, not by a cloud provider');
    expect(local).toContain('never invent a figure');
    // With no server found at the port, the address names it.
    expect(runtimeGuidance({ endpointUrl: 'http://127.0.0.1:8000/v1', model: 'm' })).toContain('served by 127.0.0.1:8000');
    const remote = runtimeGuidance({ endpointUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder:free', subagentModel: 'small' }, 'OpenRouter');
    expect(remote).toContain('served by OpenRouter at https://openrouter.ai/api/v1, a provider reached over the internet');
    expect(remote).toContain('Subagents a plugin starts run on small, through the same server.');
    // A local chat with its subagents on a provider is told so: what it hands them leaves this computer.
    const split = runtimeGuidance({ endpointUrl: 'http://127.0.0.1:8000/v1', model: 'local', subagentModel: 'google/gemini-3-flash', subagentEndpointUrl: 'https://openrouter.ai/api/v1' });
    expect(split).toContain('Subagents a plugin starts run on google/gemini-3-flash, on another server: openrouter.ai, a provider reached over the internet. What you hand a subagent is sent there.');
    // No model chosen yet: nothing to claim.
    expect(runtimeGuidance({ endpointUrl: 'http://localhost:8000/v1', model: '' })).toBe('');
  });
});
