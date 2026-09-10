import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, CircleCheck } from 'lucide-react';
import { useStore } from 'zustand/react';

import { endpointsStore } from '../state/endpoints';
import { settingsStore } from '../state/settings';
import { Reveal } from '../ui/Reveal';
import { TruncatedText } from '../ui/TruncatedText';
import { useOverlayLock } from '../ui/useOverlayLock';
import type { Endpoint, Model } from '../../shared/types';

import { ambiguousEndpointIds, endpointDistinguisher, endpointLabel } from './endpoint-identity';
import './ModelSelector.css';

type NavigationItem = { kind: 'model'; model: Model } | { kind: 'endpoint'; endpoint: Endpoint };
const EMPTY_MODELS: Model[] = [];

/** What the list can say about itself, or null when it has nothing to say. */
export type ModelListNotice = 'loading' | 'unlisted' | 'empty' | 'no-matches';

/**
 * Which of those the list is in.
 *
 * `unlisted` is the state that did not exist before and had to: the store
 * writes `models[id]` only when `listModels` succeeds, so an endpoint that has
 * not answered — not yet, or not at all, because the request failed — is
 * `undefined` there, and reading that as an empty array told the user their
 * server has no models when nothing had ever asked it. Never having heard is
 * not an answer (DESIGNUIguide.md §State pills: "absence is not a statement").
 *
 * `loading` stays reserved for a request this component itself just started,
 * which is the only case where progress is a fact rather than a hope.
 */
export function deriveModelListNotice(input: {
  hasActiveEndpoint: boolean;
  switching: boolean;
  /** `undefined` when nothing has answered for this endpoint. */
  models: Model[] | undefined;
  filteredCount: number;
}): ModelListNotice | null {
  if (input.switching) return 'loading';
  if (!input.hasActiveEndpoint) return null;
  if (input.models === undefined) return 'unlisted';
  if (input.models.length === 0) return 'empty';
  if (input.filteredCount === 0) return 'no-matches';
  return null;
}

export function modelListNoticeText(notice: ModelListNotice): string {
  switch (notice) {
    case 'loading':
      return 'Loading models…';
    case 'unlisted':
      // Neither "there are none" nor a promise that something is on its way:
      // this component cannot tell a slow answer from one that never came.
      return 'This endpoint has not listed its models.';
    case 'empty':
      return 'No models available';
    case 'no-matches':
      return 'No matching models';
  }
}

/** The compact label prefers a human name, then the id's final path segment. */
export function modelShortName(model: Pick<Model, 'id' | 'displayName'>): string {
  const displayName = model.displayName?.trim();
  if (displayName) return displayName;
  return model.id.split('/').filter(Boolean).at(-1) ?? model.id;
}

/**
 * An endpoint's name, its state tags, and — only where its name is not enough
 * to tell it from another row — the facts that differ.
 *
 * This is the list the user actually reaches (DESIGNUIguide.md §Window chrome:
 * endpoint and model selection live in the composer chip), so it is where four
 * copies of "OpenRouter" have to become four distinguishable things. The same
 * shape serves the active endpoint's group header and every switchable row, so
 * the one that is current is identified on the same terms as the alternatives.
 */
export function EndpointIdentity({
  endpoint,
  ambiguous,
}: {
  endpoint: Endpoint;
  ambiguous: boolean;
}): JSX.Element {
  return (
    <>
      <span className="model-selector__identity-main">
        <TruncatedText className="model-selector__identity-name" title={endpoint.baseUrl}>
          {endpointLabel(endpoint)}
        </TruncatedText>
        {ambiguous && !endpoint.hasApiKey ? (
          <span className="model-selector__nokey">no key</span>
        ) : null}
        {endpoint.verifiedAt !== null ? (
          <CircleCheck className="model-selector__verified" aria-label="verified" />
        ) : (
          <span className="model-selector__unverified">unverified</span>
        )}
      </span>
      {ambiguous ? (
        <TruncatedText className="model-selector__identity-detail">
          {endpointDistinguisher(endpoint)}
        </TruncatedText>
      ) : null}
    </>
  );
}

interface ModelSelectorProps {
  onAddEndpoint: () => void;
}

/** The app's single model/endpoint control, mounted in the composer. */
export default function ModelSelector({ onAddEndpoint }: ModelSelectorProps) {
  const endpoints = useStore(endpointsStore, (state) => state.endpoints);
  const activeEndpointId = useStore(endpointsStore, (state) => state.activeEndpointId);
  const activeModelId = useStore(endpointsStore, (state) => state.activeModelId);
  const models = useStore(endpointsStore, (state) => state.models);

  const popoverRequested = useStore(settingsStore, (state) => state.modelPopoverRequested);
  const setPopoverRequested = useStore(settingsStore, (state) => state.setModelPopoverRequested);

  const [open, setOpen] = useState(false);
  // T146: this popover hangs off the composer chip and can extend across the
  // split, where the pane's native view would otherwise cover it.
  useOverlayLock(open);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [switchingEndpointId, setSwitchingEndpointId] = useState<string | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const optionId = (index: number) => `${listboxId}-opt-${index}`;

  const activeEndpoint =
    activeEndpointId === null
      ? null
      : (endpoints.find((endpoint) => endpoint.id === activeEndpointId) ?? null);
  // Kept apart on purpose: `undefined` means nothing has answered for this
  // endpoint, `[]` means it answered with nothing. Collapsing them made the
  // chip assert the second whenever the first was true.
  const listedModels = activeEndpointId === null ? undefined : models[activeEndpointId];
  const activeModels = listedModels ?? EMPTY_MODELS;
  const activeModel =
    activeEndpointId === null || activeModelId === null
      ? null
      : (activeModels.find((model) => model.id === activeModelId) ?? {
          id: activeModelId,
          endpointId: activeEndpointId ?? '',
          source: 'manual' as const,
          verifiedAt: null,
        });
  const otherEndpoints = endpoints.filter((endpoint) => endpoint.id !== activeEndpointId);
  // Computed over every endpoint, not just the switchable ones: the active
  // endpoint sits in the group header and is one of the identical copies.
  const ambiguous = useMemo(() => ambiguousEndpointIds(endpoints), [endpoints]);

  const filteredModels = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return activeModels;
    return activeModels.filter((model) => model.id.toLowerCase().includes(normalizedQuery));
  }, [activeModels, query]);

  const navigationItems = useMemo<NavigationItem[]>(
    () => [
      ...filteredModels.map((model): NavigationItem => ({ kind: 'model', model })),
      ...otherEndpoints.map((endpoint): NavigationItem => ({ kind: 'endpoint', endpoint })),
    ],
    [filteredModels, otherEndpoints],
  );

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (open) {
      // Reveal mounts its children from an effect; wait one frame so the
      // search field exists before moving keyboard focus into the popover.
      const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
      return () => window.cancelAnimationFrame(frame);
    }
    setQuery('');
    setHighlight(0);
    return undefined;
  }, [open]);

  // The stream-failure banner's "Switch model…" action reaches the chip
  // through the store rather than embedding a second selector
  // (DESIGNUIguide.md §Errors). Consume the request as it opens the popover so
  // a later close does not immediately reopen it.
  useEffect(() => {
    if (!popoverRequested) return;
    setPopoverRequested(false);
    setOpen(true);
  }, [popoverRequested, setPopoverRequested]);

  useEffect(() => {
    setHighlight((current) =>
      navigationItems.length === 0 ? 0 : Math.min(current, navigationItems.length - 1),
    );
  }, [navigationItems.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  const chooseModel = useCallback(
    (model: Model) => {
      if (activeEndpointId === null) return;
      void endpointsStore.getState().setActiveModel(activeEndpointId, model.id);
      close();
    },
    [activeEndpointId, close],
  );

  const chooseEndpoint = useCallback(async (endpoint: Endpoint) => {
    setQuery('');
    setHighlight(0);
    setSwitchingEndpointId(endpoint.id);
    // A model belongs to its endpoint; never expose the previous pairing while switching.
    endpointsStore.setState({ activeModelId: null });
    try {
      await endpointsStore.getState().setActiveEndpoint(endpoint.id);
    } finally {
      setSwitchingEndpointId(null);
      inputRef.current?.focus();
    }
  }, []);

  const activateHighlighted = useCallback(() => {
    const item = navigationItems[highlight];
    if (!item) return;
    if (item.kind === 'model') chooseModel(item.model);
    else void chooseEndpoint(item.endpoint);
  }, [chooseEndpoint, chooseModel, highlight, navigationItems]);

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (navigationItems.length > 0) {
          setHighlight((current) => (current + 1) % navigationItems.length);
        }
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (navigationItems.length > 0) {
          setHighlight(
            (current) => (current - 1 + navigationItems.length) % navigationItems.length,
          );
        }
        break;
      case 'Home':
        event.preventDefault();
        setHighlight(0);
        break;
      case 'End':
        event.preventDefault();
        setHighlight(Math.max(0, navigationItems.length - 1));
        break;
      case 'Enter':
        event.preventDefault();
        activateHighlighted();
        break;
      case 'Escape':
        event.preventDefault();
        close();
        break;
      default:
        break;
    }
  }

  const notice = deriveModelListNotice({
    hasActiveEndpoint: activeEndpoint !== null,
    switching: switchingEndpointId !== null,
    models: listedModels,
    filteredCount: filteredModels.length,
  });

  const triggerLabel = activeModel === null ? 'No model' : modelShortName(activeModel);
  const activeDescendant = navigationItems[highlight] ? optionId(highlight) : undefined;

  return (
    <div className="model-selector" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="model-selector__trigger"
        data-testid="model-selector"
        aria-label={
          activeModelId === null
            ? 'Select model or endpoint'
            : `Select model or endpoint, current model ${activeModelId}`
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        title={activeModelId ?? undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <TruncatedText className="model-selector__trigger-label">{triggerLabel}</TruncatedText>
        <ChevronDown className="model-selector__trigger-icon" aria-hidden="true" />
      </button>

      <Reveal show={open} className="model-selector__popover">
        <div role="dialog" aria-label="Select a model" aria-hidden={open ? undefined : 'true'}>
          <input
            ref={inputRef}
            type="search"
            className="model-selector__search"
            data-testid="model-search"
            placeholder="Search models…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={onSearchKeyDown}
            aria-label="Search models"
            aria-controls={listboxId}
            aria-activedescendant={activeDescendant}
          />

          {listedModels !== undefined ? (
            <p className="model-selector__count" aria-live="polite">
              {filteredModels.length} of {activeModels.length} models
            </p>
          ) : null}

          <div className="model-selector__scroll">
            {activeEndpoint ? (
              <div className="model-selector__group-header">
                <EndpointIdentity
                  endpoint={activeEndpoint}
                  ambiguous={ambiguous.has(activeEndpoint.id)}
                />
              </div>
            ) : null}

            {notice !== null ? (
              <p className="model-selector__notice">{modelListNoticeText(notice)}</p>
            ) : null}

            <ul id={listboxId} className="model-selector__list" role="listbox" tabIndex={-1}>
              {filteredModels.map((model, index) => (
                <li
                  key={`${activeEndpointId}:${model.id}`}
                  id={optionId(index)}
                  role="option"
                  data-testid="model-option"
                  data-model-id={model.id}
                  data-highlighted={index === highlight ? 'true' : undefined}
                  aria-selected={model.id === activeModelId}
                  aria-label={model.id}
                  title={model.id}
                  className="model-selector__option model-selector__model"
                  onMouseMove={() => setHighlight(index)}
                  onClick={() => chooseModel(model)}
                >
                  <TruncatedText>{model.id}</TruncatedText>
                </li>
              ))}

              {otherEndpoints.map((endpoint, endpointIndex) => {
                const index = filteredModels.length + endpointIndex;
                return (
                  <li
                    key={endpoint.id}
                    id={optionId(index)}
                    role="option"
                    data-testid="endpoint-option"
                    data-highlighted={index === highlight ? 'true' : undefined}
                    aria-selected="false"
                    className="model-selector__option model-selector__endpoint"
                    onMouseMove={() => setHighlight(index)}
                    onClick={() => void chooseEndpoint(endpoint)}
                  >
                    <EndpointIdentity endpoint={endpoint} ambiguous={ambiguous.has(endpoint.id)} />
                  </li>
                );
              })}
            </ul>
          </div>

          <button
            type="button"
            className="model-selector__footer"
            onClick={() => {
              setOpen(false);
              onAddEndpoint();
            }}
          >
            Add endpoint…
          </button>
        </div>
      </Reveal>
    </div>
  );
}
