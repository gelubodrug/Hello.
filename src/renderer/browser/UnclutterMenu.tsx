import { useCallback, useEffect, useState } from 'react';
import { Eraser, Power, RotateCw, Trash2, WandSparkles } from 'lucide-react';
import type { BrowserTab } from '../../shared/types';
import { UNCLUTTER_CLASSIFIERS, type UnclutterOverview, type UnclutterTabState } from '../../shared/unclutter';
import { api } from '../api';
import { MenuButton, type MenuItem } from '../ui/primitives';

interface Props { tab: BrowserTab; onError(message: string): void; }

const KIND_WORDS: Record<string, [string, string]> = {
  ad: ['ad', 'ads'], cookie: ['consent banner', 'consent banners'], promotion: ['promotion', 'promotions'],
  newsletter: ['newsletter prompt', 'newsletter prompts'], social: ['social nag', 'social nags'],
};

/** "3 ads · 1 consent banner" — what a page type's rules hide, by kind. */
export function rulesSummary(categories: Record<string, number>): string {
  const parts = Object.entries(categories).filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${(KIND_WORDS[kind] ?? [kind, kind])[count === 1 ? 0 : 1]}`);
  return parts.length ? parts.join(' · ') : 'Nothing to hide was found';
}

/** What the first row of the menu says about this page. */
export function pageLine(state: UnclutterTabState, classifier = 'The model'): { label: string; detail?: string } {
  if (!state.eligible) return { label: 'Not cleaned', detail: 'Generated documents, previewed files and local servers are never touched' };
  if (state.analyzing) return { label: state.analyzing.total ? `Analysing… ${state.analyzing.done} of ${state.analyzing.total}` : 'Reading the page…', detail: `${classifier} classifies the page’s blocks` };
  const hidden = state.hidden === 1 ? '1 block hidden' : state.hidden ? `${state.hidden} blocks hidden` : 'Nothing hidden';
  if (!state.profile) return { label: hidden, detail: state.label ? `${state.label} — not analysed yet` : undefined };
  return { label: hidden, detail: `${state.label ?? 'This page type'}${state.profile.enabled ? '' : ' (off)'} — ${rulesSummary(state.profile.categories)}` };
}

/**
 * Unclutter on the toolbar: a button that counts the blocks hidden on the
 * page, and a menu to analyse this page type with the chosen model (Decider
 * V1.3 on OpenRouter, or OpenJev on this Mac), switch its rules off, forget
 * them, choose the model, or turn Unclutter and its Auto mode on and off. The
 * person's own switch: AI Mode does not gate it, and the agent never sees it.
 */
export function UnclutterMenu({ tab, onError }: Props): JSX.Element | null {
  const bridge = api.unclutter;
  const [overview, setOverview] = useState<UnclutterOverview | null>(null);
  const [state, setState] = useState<UnclutterTabState | null>(null);
  const refresh = useCallback(() => {
    if (!bridge) return;
    void bridge.overview(tab.id).then(next => { setOverview(next); setState(next.tab); }).catch(() => {});
  }, [bridge, tab.id]);
  useEffect(() => { setState(null); refresh(); }, [refresh]);
  useEffect(() => bridge?.onChange(next => { if (next.tabId === tab.id) setState(next); }), [bridge, tab.id]);
  if (!bridge) return null;
  const run = (task: () => Promise<unknown>) => { void task().then(refresh, (error: Error) => { onError(error.message); refresh(); }); };
  const switches = overview?.switches ?? { enabled: true, auto: false, classifier: UNCLUTTER_CLASSIFIERS[0].id };
  const model = overview?.classifier;
  const name = model?.name ?? UNCLUTTER_CLASSIFIERS.find(entry => entry.id === switches.classifier)?.name ?? 'The model';
  const current = state ?? { tabId: tab.id, eligible: false, hidden: 0, profile: null, analyzing: null };
  const line = pageLine(current, name);
  const busy = current.analyzing !== null;
  const items: MenuItem[] = [
    { id: 'page', label: line.label, detail: line.detail, icon: Eraser, disabled: true },
    ...(current.error ? [{ id: 'error', label: 'The last analysis failed', detail: current.error, disabled: true }] : []),
    { id: 'analyze', label: current.profile ? 'Analyse this page type again' : 'Analyse this page type', icon: current.profile ? RotateCw : WandSparkles,
      detail: model?.state === 'missing' ? model.detail : model?.state === 'ready' ? `${name} is ready` : 'Starts OpenJev on this Mac (about 27 GB) if it is off',
      disabled: busy || !current.eligible || !switches.enabled || model?.state === 'missing', separator: true,
      action: () => run(() => bridge.analyze(tab.id)) },
    ...(current.profile ? [
      { id: 'type', label: 'Clean this page type', toggle: true, stayOpen: true, checked: current.profile.enabled, disabled: busy || !switches.enabled,
        action: () => run(() => bridge.setTypeEnabled(tab.id, !current.profile!.enabled)) },
      { id: 'forget', label: 'Forget this page type', icon: Trash2, detail: 'Its blocks show again until it is analysed', disabled: busy,
        action: () => run(() => bridge.forgetType(tab.id)) },
    ] : []),
    { id: 'enabled', label: 'Unclutter', detail: 'Hide what the model classified on every site', toggle: true, stayOpen: true, checked: switches.enabled, separator: true,
      action: () => run(() => bridge.setSwitches({ enabled: !switches.enabled })) },
    { id: 'auto', label: 'Analyse new page types automatically', detail: `Asks ${name} the first time a page type is shown`, toggle: true, stayOpen: true,
      checked: switches.auto, disabled: !switches.enabled, action: () => run(() => bridge.setSwitches({ auto: !switches.auto })) },
    ...UNCLUTTER_CLASSIFIERS.map((entry, index) => ({ id: `model-${entry.id}`, label: entry.name, detail: entry.id === switches.classifier ? model?.detail ?? entry.where : entry.where,
      checked: entry.id === switches.classifier, stayOpen: true, separator: index === 0, disabled: busy,
      action: () => { if (entry.id !== switches.classifier) run(() => bridge.setSwitches({ classifier: entry.id })); } })),
    ...(model?.id === 'openjev' && model.ownHelper ? [{ id: 'stop', label: 'Stop OpenJev', icon: Power, detail: 'Frees its memory; the next analysis starts it again', disabled: busy,
      action: () => run(() => bridge.stopOpenJev()) }] : []),
  ];
  const hidden = current.eligible && switches.enabled ? current.hidden : 0;
  return <div className="browser-unclutter-anchor" data-busy={busy ? 'true' : undefined}>
    <MenuButton className="browser-unclutter" label={hidden ? `Unclutter — ${hidden} hidden` : 'Unclutter'} menuLabel="Unclutter" heading="Unclutter"
      items={items} onOpen={refresh}>
      <Eraser size={16} aria-hidden="true" />
      {hidden ? <span className="browser-unclutter-count" aria-hidden="true">{hidden > 99 ? '99+' : hidden}</span> : null}
    </MenuButton>
  </div>;
}
