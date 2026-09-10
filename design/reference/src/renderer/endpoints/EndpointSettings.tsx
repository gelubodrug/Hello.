import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronRight, Trash2 } from 'lucide-react';

import { endpointsStore } from '../state/endpoints';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { RequestDiagnosticDetails } from '../ui/RequestDiagnosticDetails';
import { Reveal } from '../ui/Reveal';
import type { RequestDiagnostic } from '../../shared/errors';
import type { Endpoint, EndpointInput, GenerationSettings } from '../../shared/types';
import type { EndpointPreset } from './presets';

import './EndpointSettings.css';

/** Fields the dialog can be opened straight onto. */
export type EndpointSettingsFocus = 'apiKey';

/**
 * What is known about this endpoint's stored key.
 *
 * Three states, not two: the key field always renders empty — a stored key is
 * never read back into the renderer (FR-016/020) — so an endpoint that has one
 * and an endpoint that has none used to look identical, and "unknown" (the
 * dialog has not heard back from the keychain yet, or the check failed) looked
 * identical to both. Reading an empty field as "my key is gone" is what sends
 * someone off to add the same endpoint again.
 */
export type ApiKeyState = 'unknown' | 'stored' | 'none';

export interface EndpointSettingsProps {
  open: boolean;
  onClose: () => void;
  /** When set, edit that endpoint; when undefined, add a new one. */
  endpointId?: string;
  /**
   * Field that takes opening focus, for a dialog opened to fix one thing —
   * the stream-failure banner sends a rejected-credentials failure here with
   * `'apiKey'` so the user lands on the key input (T147).
   */
  focusField?: EndpointSettingsFocus;
  /**
   * Values a known provider was picked from. They seed the form and are then
   * out of the picture: every field stays editable and nothing keeps a record
   * of which preset — if any — the saved endpoint started as.
   */
  preset?: EndpointPreset;
}

/** Header names permitted by RFC 7230 token grammar. */
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 2048;
const DECIMAL_INPUT_PATTERN = '[0-9]*[.,]?[0-9]*';

export interface HeaderRow {
  /** Stable key for React row identity. */
  rowId: number;
  name: string;
  value: string;
}

type ProbeState =
  | { phase: 'idle' }
  | { phase: 'testing' }
  | { phase: 'verified'; verifiedAt: number | null }
  | { phase: 'error'; message: string; diagnostic?: RequestDiagnostic };

/** Fields whose edit invalidates a prior successful probe (FR-003). */
type ProbeAffecting = 'baseUrl' | 'apiKey' | 'headers';

/**
 * What an empty key field means, spelled out. The field is empty in all three
 * states; only this line says whether that emptiness is a kept key, no key at
 * all, or an answer that has not arrived.
 */
export function apiKeyStateHint(state: ApiKeyState): string | null {
  switch (state) {
    case 'stored':
      return 'A key is stored in the keychain and is never shown here. Leave this blank to keep it; type a new key to replace it.';
    case 'none':
      return 'No key is stored for this endpoint. A server that needs one will refuse every request until you type it here.';
    default:
      return null;
  }
}

/** Placeholder that matches the hint, so the field alone is not misleading. */
export function apiKeyPlaceholder(state: ApiKeyState): string {
  switch (state) {
    case 'stored':
      return 'leave blank to keep the stored key';
    case 'none':
      return 'paste the key';
    default:
      return '';
  }
}

export interface ApiKeyStateBadgeProps {
  state: ApiKeyState;
  /** Whether the two-step removal is mid-question. */
  confirming: boolean;
  disabled: boolean;
  onStartRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
}

/**
 * The one place the dialog says whether a key exists.
 *
 * "No key stored" is stated, not implied by an absent badge: absence reads as
 * "still loading" and carries no information. Nothing at all renders while the
 * answer is genuinely unknown, so the dialog never guesses out loud.
 *
 * Removal is deliberate — a blank field means "keep", so this is the only way
 * to take a wrong key back out — and therefore asks first, like Delete does.
 */
export function ApiKeyStateBadge({
  state,
  confirming,
  disabled,
  onStartRemove,
  onCancelRemove,
  onConfirmRemove,
}: ApiKeyStateBadgeProps): JSX.Element | null {
  if (state === 'unknown') {
    return null;
  }

  if (state === 'none') {
    return <span className="es-badge es-badge-off">No key stored</span>;
  }

  return (
    <span className="es-key-state">
      <span className="es-badge es-badge-on">Key stored</span>
      {confirming ? (
        <span className="es-confirm-inline">
          <span>Remove it?</span>
          <button type="button" className="es-linkbtn" onClick={onCancelRemove}>
            Cancel
          </button>
          <button
            type="button"
            className="es-delete-btn"
            disabled={disabled}
            onClick={onConfirmRemove}
          >
            Remove
          </button>
        </span>
      ) : (
        <button type="button" className="es-linkbtn" disabled={disabled} onClick={onStartRemove}>
          Remove key
        </button>
      )}
    </span>
  );
}

function formatTimestamp(ts: number | null): string {
  if (ts == null) return '';
  const d = new Date(ts);
  // Locale time is fine here; the value is display-only.
  return d.toLocaleString();
}

export function normalizeDecimalInput(value: string): string {
  return value.replace(/,/g, '.');
}

/** Last-resort example when nothing better is known about the server yet. */
const FALLBACK_MODEL_EXAMPLE = 'llama-3.1-8b-instruct';

/**
 * What the Model ID field offers as an example, in the order the dialog
 * actually learns things.
 *
 * Once the server has answered with its catalogue the field is a filter over
 * that catalogue — the datalist matches any part of an id — so the useful
 * thing to say is how many models are behind it and that typing narrows them.
 * Before that, the best available example is the shape the chosen provider
 * uses; a model id from an unrelated provider, which is what this said before,
 * tells the user nothing about the endpoint they are configuring.
 */
export function modelIdPlaceholder(suggestionCount: number, exampleModel?: string): string {
  if (suggestionCount > 0) {
    const models = suggestionCount === 1 ? '1 model' : `${suggestionCount} models`;
    return `optional — type to filter ${models}, e.g. free`;
  }

  return `optional — e.g. ${exampleModel ?? FALLBACK_MODEL_EXAMPLE}`;
}

/**
 * Said only once the server's list is in hand, because it is a claim about
 * that list. "free" is the example on purpose: on a catalogue like
 * OpenRouter's it is the one filter people arrive wanting and the one the
 * field gave no way to guess.
 */
export const MODEL_FILTER_HINT =
  'Filtering matches any part of an id, so typing free lists the free models this server reports.';

export interface ModelIdFieldProps {
  id: string;
  /** Id of the datalist element this field renders alongside its input. */
  dataListId: string;
  value: string;
  /** Model ids this endpoint reported; empty until a probe or an edit-load. */
  suggestions: readonly string[];
  /** The chosen preset's example, for the state before any list exists. */
  exampleModel?: string;
  onChange: (value: string) => void;
}

/** Optional pin: which model this endpoint opens on. Empty means "ask later". */
export function ModelIdField({
  id,
  dataListId,
  value,
  suggestions,
  exampleModel,
  onChange,
}: ModelIdFieldProps): JSX.Element {
  const hasSuggestions = suggestions.length > 0;
  const hintId = `${id}-filter-hint`;

  return (
    <div className="es-field">
      <label htmlFor={id}>Model ID</label>
      <Input
        id={id}
        value={value}
        list={hasSuggestions ? dataListId : undefined}
        aria-describedby={hasSuggestions ? hintId : undefined}
        placeholder={modelIdPlaceholder(suggestions.length, exampleModel)}
        onChange={(e) => onChange(e.target.value)}
      />
      {hasSuggestions ? (
        <>
          <datalist id={dataListId}>
            {suggestions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <small className="es-hint" id={hintId}>
            {MODEL_FILTER_HINT}
          </small>
        </>
      ) : null}
    </div>
  );
}

export interface CustomHeadersFieldProps {
  /** Also the target `focusFirstInvalid` reaches for when a name is invalid. */
  id: string;
  headers: readonly HeaderRow[];
  /** Validation message for the group, once it is worth showing. */
  error?: string;
  invalidName: (row: HeaderRow) => boolean;
  onAdd: () => void;
  onUpdate: (rowId: number, patch: Partial<Pick<HeaderRow, 'name' | 'value'>>) => void;
  onRemove: (rowId: number) => void;
  onNameBlur: () => void;
}

/**
 * Custom headers, folded away (DESIGNUIguide.md §UX rules — progressive
 * disclosure). They are real — every chat request, model discovery and coder
 * turn sends them — but almost nobody needs one, and standing open in the
 * middle of the form they read as a step to complete rather than an option to
 * ignore.
 *
 * Two things open the panel on their own. An endpoint that already carries
 * headers shows them, because they are part of what this endpoint is. And an
 * invalid header name forces it open and stays open: a validation error hidden
 * behind a closed panel is worse than the field being in the way, and Save
 * sends focus in here. The message itself renders outside the panel so it is
 * legible either way.
 */
export function CustomHeadersField({
  id,
  headers,
  error,
  invalidName,
  onAdd,
  onUpdate,
  onRemove,
  onNameBlur,
}: CustomHeadersFieldProps): JSX.Element {
  const savedHeaderCount = headers.length;
  const [expanded, setExpanded] = useState(savedHeaderCount > 0);

  // Headers usually arrive after the dialog mounts — the edit load reads the
  // endpoint asynchronously — so the same rule is needed twice: once for the
  // headers already in hand at mount, and once for the ones that turn up.
  useEffect(() => {
    if (savedHeaderCount > 0) setExpanded(true);
  }, [savedHeaderCount]);

  const open = expanded || error !== undefined;
  const panelId = `${id}-panel`;

  return (
    <div className="es-field">
      <button
        type="button"
        id={id}
        className="es-disclosure"
        aria-expanded={open}
        // Only while it exists: the panel unmounts when collapsed.
        aria-controls={open ? panelId : undefined}
        onClick={() => setExpanded((previous) => !previous)}
      >
        <ChevronRight className="es-disclosure-chevron" size={14} aria-hidden="true" />
        <span className="es-group-label">Custom headers</span>
        {headers.length > 0 ? <span className="es-disclosure-count">{headers.length}</span> : null}
      </button>

      {error !== undefined ? (
        <small className="es-error" role="alert">
          {error}
        </small>
      ) : null}

      <Reveal show={open} duration="fast">
        <div className="es-headers-panel" id={panelId}>
          <small className="es-hint">
            Sent with every request to this endpoint. Most servers need none.
          </small>
          {headers.length > 0 ? (
            <ul className="es-headers">
              {headers.map((row) => (
                <li key={row.rowId} className="es-header-row">
                  <Input
                    aria-label="Header name"
                    value={row.name}
                    invalid={invalidName(row)}
                    placeholder="Header-Name"
                    onChange={(e) => onUpdate(row.rowId, { name: e.target.value })}
                    onBlur={onNameBlur}
                  />
                  <Input
                    aria-label="Header value"
                    value={row.value}
                    placeholder="value"
                    onChange={(e) => onUpdate(row.rowId, { value: e.target.value })}
                  />
                  <button
                    type="button"
                    className="es-icon-btn"
                    aria-label="Remove header"
                    onClick={() => onRemove(row.rowId)}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <Button type="button" variant="secondary" onClick={onAdd}>
            Add header
          </Button>
        </div>
      </Reveal>
    </div>
  );
}

/**
 * Add/edit endpoint dialog. Save is gated behind a successful test-probe
 * (FR-003); the API key is written straight to the keychain via
 * `secrets.setEndpointKey` and never re-enters the renderer (FR-016/020).
 */
export default function EndpointSettings({
  open,
  onClose,
  endpointId,
  focusField,
  preset,
}: EndpointSettingsProps): JSX.Element {
  const isEdit = endpointId != null;
  // A provider that needs a key opens on the key field: name and URL are
  // already filled, so the key is the only thing left to type.
  const openingFocus = focusField ?? (preset?.requiresApiKey ? 'apiKey' : undefined);

  // --- form field state -----------------------------------------------------
  const [displayName, setDisplayName] = useState(preset?.displayName ?? '');
  const [baseUrl, setBaseUrl] = useState(preset?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [modelId, setModelId] = useState('');
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const [timeoutMs, setTimeoutMs] = useState(String(DEFAULT_TIMEOUT_MS));
  const [temperature, setTemperature] = useState(String(DEFAULT_TEMPERATURE));
  const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MAX_TOKENS));

  // The persisted endpoint id (existing when editing, or captured from a draft
  // save during the first probe). Never mirrored into any long-lived store.
  const [currentId, setCurrentId] = useState<string | undefined>(endpointId);

  // Three-valued on purpose: see ApiKeyState. Starts unknown so the dialog
  // says nothing about the key until the keychain has answered.
  const [keyState, setKeyState] = useState<ApiKeyState>('unknown');
  const [confirmingKeyRemoval, setConfirmingKeyRemoval] = useState(false);
  // Whether a dev-only `key.txt` exists in the project folder. Surfaced as an
  // available key source only; its value never enters the renderer and is
  // never auto-copied into the keychain.
  const [projectKeyAvailable, setProjectKeyAvailable] = useState(false);
  const [modelSuggestions, setModelSuggestions] = useState<string[]>([]);

  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [probe, setProbe] = useState<ProbeState>({ phase: 'idle' });
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const rowSeq = useRef(0);

  const uid = useId();
  const fieldId = useCallback((name: string) => `${uid}-${name}`, [uid]);

  const nextRowId = useCallback(() => {
    rowSeq.current += 1;
    return rowSeq.current;
  }, []);

  // --- load / reset on open -------------------------------------------------
  const resetForm = useCallback(() => {
    setDisplayName(preset?.displayName ?? '');
    setBaseUrl(preset?.baseUrl ?? '');
    setApiKey('');
    setModelId('');
    setHeaders([]);
    setTimeoutMs(String(DEFAULT_TIMEOUT_MS));
    setTemperature(String(DEFAULT_TEMPERATURE));
    setMaxTokens(String(DEFAULT_MAX_TOKENS));
    setCurrentId(endpointId);
    setKeyState('unknown');
    setConfirmingKeyRemoval(false);
    setProjectKeyAvailable(false);
    setModelSuggestions([]);
    setTouched({});
    setSubmitAttempted(false);
    setProbe({ phase: 'idle' });
    setBusy(false);
    setConfirmingDelete(false);
    setFormError(null);
  }, [endpointId, preset]);

  const populateFrom = useCallback(
    (ep: Endpoint) => {
      setDisplayName(ep.displayName);
      setBaseUrl(ep.baseUrl);
      setTimeoutMs(String(ep.timeoutMs));
      setTemperature(String(ep.defaults.temperature));
      setMaxTokens(String(ep.defaults.maxTokens ?? DEFAULT_MAX_TOKENS));
      setHeaders(
        Object.entries(ep.customHeaders).map(([name, value]) => ({
          rowId: nextRowId(),
          name,
          value,
        })),
      );
      // A discovery/prior verification counts as a valid initial probe.
      if (ep.verifiedAt !== null) {
        setProbe({ phase: 'verified', verifiedAt: ep.verifiedAt });
      }
    },
    [nextRowId],
  );

  // Detect the optional dev-only `key.txt` source whenever the dialog opens,
  // for both add and edit. Presence only — the value never crosses IPC.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const res = await window.api.secrets.hasProjectKey();
      if (!cancelled && res.ok) setProjectKeyAvailable(res.value);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    resetForm();

    if (endpointId == null) return;
    let cancelled = false;

    void (async () => {
      const [listRes, hasKeyRes, modelsRes] = await Promise.all([
        window.api.endpoints.listEndpoints(),
        window.api.secrets.hasEndpointKey(endpointId),
        window.api.models.listModels(endpointId),
      ]);
      if (cancelled) return;

      if (listRes.ok) {
        const ep = listRes.value.find((e) => e.id === endpointId);
        if (ep) populateFrom(ep);
      }
      // A failed check leaves the state unknown rather than asserting "none":
      // claiming a stored key is gone is exactly the wrong thing to guess.
      if (hasKeyRes.ok) setKeyState(hasKeyRes.value ? 'stored' : 'none');
      if (modelsRes.ok) setModelSuggestions(modelsRes.value.map((m) => m.id));
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, endpointId]);

  // --- validation -----------------------------------------------------------
  const headerNameError = useCallback(
    (row: HeaderRow): boolean => row.name.trim() !== '' && !HEADER_NAME_RE.test(row.name),
    [],
  );

  const errors = useMemo(() => {
    const e: Record<string, string> = {};

    if (displayName.trim() === '') e.displayName = 'Display name is required.';

    if (baseUrl.trim() === '') {
      e.baseUrl = 'Base URL is required.';
    } else {
      try {
        const parsed = new URL(baseUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          e.baseUrl = 'Base URL must use http or https.';
        }
      } catch {
        e.baseUrl = 'Enter a valid URL.';
      }
    }

    const anyHeaderInvalid = headers.some(headerNameError);
    if (anyHeaderInvalid) e.headers = 'Fix highlighted header names.';

    const t = Number(timeoutMs);
    if (timeoutMs.trim() === '' || Number.isNaN(t)) {
      e.timeoutMs = 'Enter a number.';
    } else if (t < 1000 || t > 600000) {
      e.timeoutMs = 'Timeout must be 1000–600000 ms.';
    }

    const temp = Number(normalizeDecimalInput(temperature));
    if (temperature.trim() === '' || Number.isNaN(temp)) {
      e.temperature = 'Enter a number.';
    } else if (temp < 0 || temp > 2) {
      e.temperature = 'Temperature must be 0–2.';
    }

    const mt = Number(maxTokens);
    if (maxTokens.trim() === '' || Number.isNaN(mt)) {
      e.maxTokens = 'Enter a number.';
    } else if (!Number.isInteger(mt) || mt < 1 || mt > 32768) {
      e.maxTokens = 'Max tokens must be 1–32768.';
    }

    return e;
  }, [displayName, baseUrl, headers, headerNameError, timeoutMs, temperature, maxTokens]);

  const hasErrors = Object.keys(errors).length > 0;

  const showError = useCallback(
    (field: string): string | undefined =>
      touched[field] || submitAttempted ? errors[field] : undefined,
    [touched, submitAttempted, errors],
  );

  const markTouched = useCallback((field: string) => {
    setTouched((prev) => (prev[field] ? prev : { ...prev, [field]: true }));
  }, []);

  // --- probe invalidation ---------------------------------------------------
  const invalidateProbe = useCallback((_field: ProbeAffecting) => {
    setProbe((prev) => (prev.phase === 'verified' ? { phase: 'idle' } : prev));
  }, []);

  // --- header row helpers ---------------------------------------------------
  const addHeader = useCallback(() => {
    setHeaders((prev) => [...prev, { rowId: nextRowId(), name: '', value: '' }]);
    invalidateProbe('headers');
  }, [nextRowId, invalidateProbe]);

  const updateHeader = useCallback(
    (rowId: number, patch: Partial<Pick<HeaderRow, 'name' | 'value'>>) => {
      setHeaders((prev) => prev.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)));
      invalidateProbe('headers');
    },
    [invalidateProbe],
  );

  const removeHeader = useCallback(
    (rowId: number) => {
      setHeaders((prev) => prev.filter((r) => r.rowId !== rowId));
      invalidateProbe('headers');
    },
    [invalidateProbe],
  );

  // --- build EndpointInput --------------------------------------------------
  const buildInput = useCallback((): EndpointInput => {
    const customHeaders: Record<string, string> = {};
    for (const row of headers) {
      const name = row.name.trim();
      if (name !== '') customHeaders[name] = row.value;
    }
    const normalizedTemperature = normalizeDecimalInput(temperature);
    const defaults: Partial<GenerationSettings> = {
      temperature: Number(normalizedTemperature),
      maxTokens: Number(maxTokens),
    };
    return {
      id: currentId,
      displayName: displayName.trim(),
      baseUrl: baseUrl.trim(),
      customHeaders,
      timeoutMs: Number(timeoutMs),
      defaults,
    };
  }, [headers, temperature, maxTokens, currentId, displayName, baseUrl, timeoutMs]);

  // --- probe ----------------------------------------------------------------
  const canProbe = !errors.displayName && !errors.baseUrl && !errors.headers && !busy;

  const runProbe = useCallback(async () => {
    setSubmitAttempted(true);
    if (!canProbe) return;
    setBusy(true);
    setFormError(null);
    setProbe({ phase: 'testing' });

    try {
      let id = currentId;
      if (id == null) {
        const saveRes = await window.api.endpoints.saveEndpoint(buildInput());
        if (!saveRes.ok) {
          setProbe({ phase: 'error', message: saveRes.error.message });
          return;
        }
        id = saveRes.value.id;
        setCurrentId(id);
      }

      if (apiKey !== '') {
        const keyRes = await window.api.secrets.setEndpointKey(id, apiKey);
        if (keyRes.ok) {
          setKeyState('stored');
        }
      }

      const testRes = await window.api.endpoints.testEndpoint(id);
      if (!testRes.ok) {
        setProbe({ phase: 'error', message: testRes.error.message });
        return;
      }
      const v = testRes.value;
      if (v.ok) {
        setProbe({ phase: 'verified', verifiedAt: v.verifiedAt });
        // Refresh model suggestions now that the endpoint answered.
        const modelsRes = await window.api.models.listModels(id);
        if (modelsRes.ok) setModelSuggestions(modelsRes.value.map((m) => m.id));
      } else {
        setProbe({
          phase: 'error',
          message: v.error ?? 'Endpoint did not verify.',
          diagnostic: v.diagnostic,
        });
      }
    } finally {
      setBusy(false);
    }
  }, [canProbe, currentId, buildInput, apiKey]);

  // --- save -----------------------------------------------------------------
  const canSave = !hasErrors && probe.phase === 'verified' && !busy;

  const focusFirstInvalid = useCallback(() => {
    const order = ['displayName', 'baseUrl', 'headers', 'timeoutMs', 'temperature', 'maxTokens'];
    const first = order.find((f) => errors[f]);
    if (!first) return;
    const el = document.getElementById(fieldId(first));
    el?.focus();
  }, [errors, fieldId]);

  const handleSave = useCallback(async () => {
    setSubmitAttempted(true);
    if (hasErrors) {
      focusFirstInvalid();
      return;
    }
    if (probe.phase !== 'verified') return;

    setBusy(true);
    setFormError(null);
    try {
      const saveRes = await window.api.endpoints.saveEndpoint(buildInput());
      if (!saveRes.ok) {
        setFormError(saveRes.error.message);
        return;
      }
      const saved = saveRes.value;

      if (apiKey !== '') {
        await window.api.secrets.setEndpointKey(saved.id, apiKey);
        // Plaintext key lives at most one render commit past this point.
        setApiKey('');
      }

      // Push the saved endpoint into the shared store: refresh the list, make
      // it active, and select the model. Saving without this left the endpoint
      // on disk only — the toolbar still read "No endpoint".
      await endpointsStore.getState().adoptEndpoint(saved.id, modelId.trim() || undefined);

      onClose();
    } finally {
      setBusy(false);
    }
  }, [hasErrors, focusFirstInvalid, probe.phase, buildInput, apiKey, modelId, onClose]);

  // --- key / delete ---------------------------------------------------------
  const removeKey = useCallback(async () => {
    if (currentId == null) return;
    const res = await window.api.secrets.clearEndpointKey(currentId);
    setConfirmingKeyRemoval(false);
    if (!res.ok) {
      // Silence here left the badge saying "Key stored" over a key that may or
      // may not still be there.
      setFormError(res.error.message);
      return;
    }
    setKeyState('none');
    // "Remove" means removed: a key typed but not yet stored would otherwise be
    // written straight back on the next probe or save.
    setApiKey('');
    // The endpoint was verified holding that key, so the standing "Verified"
    // no longer describes the endpoint as it is now. Make it earn Save again.
    setProbe((prev) => (prev.phase === 'verified' ? { phase: 'idle' } : prev));
  }, [currentId]);

  const confirmDelete = useCallback(async () => {
    if (currentId == null) return;
    setBusy(true);
    try {
      // Through the store, so every list in the window loses the row with it —
      // and the toolbar stops naming an endpoint that is no longer there.
      const res = await endpointsStore.getState().removeEndpoint(currentId);
      if (!res.ok) {
        setFormError(res.error.message);
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  }, [currentId, onClose]);

  const dataListId = fieldId('models');
  const title = isEdit ? 'Edit endpoint' : 'Add endpoint';

  return (
    <Dialog open={open} onClose={onClose} title={title} className="endpoint-settings">
      <form
        className="es-form"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
      >
        {/* 1. Display name */}
        <div className="es-field">
          <label htmlFor={fieldId('displayName')}>Display name</label>
          <Input
            id={fieldId('displayName')}
            value={displayName}
            invalid={Boolean(showError('displayName'))}
            onChange={(e) => setDisplayName(e.target.value)}
            onBlur={() => markTouched('displayName')}
          />
          {showError('displayName') ? (
            <small className="es-error" role="alert">
              {showError('displayName')}
            </small>
          ) : null}
        </div>

        {/* 2. Base URL */}
        <div className="es-field">
          <label htmlFor={fieldId('baseUrl')}>Base URL</label>
          <Input
            id={fieldId('baseUrl')}
            value={baseUrl}
            inputMode="url"
            placeholder="https://localhost:1234/v1"
            invalid={Boolean(showError('baseUrl'))}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              invalidateProbe('baseUrl');
            }}
            onBlur={() => markTouched('baseUrl')}
          />
          {showError('baseUrl') ? (
            <small className="es-error" role="alert">
              {showError('baseUrl')}
            </small>
          ) : null}
        </div>

        {/* 3. API key */}
        <div className="es-field">
          <div className="es-label-row">
            <label htmlFor={fieldId('apiKey')}>API key</label>
            <ApiKeyStateBadge
              state={keyState}
              confirming={confirmingKeyRemoval}
              disabled={busy}
              onStartRemove={() => setConfirmingKeyRemoval(true)}
              onCancelRemove={() => setConfirmingKeyRemoval(false)}
              onConfirmRemove={() => void removeKey()}
            />
          </div>
          <Input
            id={fieldId('apiKey')}
            type="password"
            autoComplete="off"
            // Dialog hands opening focus to this field when the dialog was
            // opened to fix credentials (T147).
            data-autofocus={openingFocus === 'apiKey' ? '' : undefined}
            value={apiKey}
            placeholder={apiKeyPlaceholder(keyState)}
            onChange={(e) => {
              setApiKey(e.target.value);
              invalidateProbe('apiKey');
            }}
          />
          {apiKeyStateHint(keyState) ? (
            <small className="es-hint">{apiKeyStateHint(keyState)}</small>
          ) : null}
          {projectKeyAvailable ? (
            <small className="es-hint">
              A <code>key.txt</code> was found in the project folder (dev). It is available as a key
              source but is never copied automatically — paste or type the key above to store it in
              the keychain.
            </small>
          ) : null}
        </div>

        {/* 4. Manual model ID */}
        <ModelIdField
          id={fieldId('modelId')}
          dataListId={dataListId}
          value={modelId}
          suggestions={modelSuggestions}
          exampleModel={preset?.exampleModel}
          onChange={setModelId}
        />

        {/* 5. Custom headers */}
        <CustomHeadersField
          id={fieldId('headers')}
          headers={headers}
          error={showError('headers')}
          invalidName={headerNameError}
          onAdd={addHeader}
          onUpdate={updateHeader}
          onRemove={removeHeader}
          onNameBlur={() => markTouched('headers')}
        />

        {/* 6/7/8. Numeric row */}
        <div className="es-numeric-grid">
          <div className="es-field">
            <label htmlFor={fieldId('timeoutMs')}>Timeout (ms)</label>
            <Input
              id={fieldId('timeoutMs')}
              type="number"
              value={timeoutMs}
              invalid={Boolean(showError('timeoutMs'))}
              onChange={(e) => setTimeoutMs(e.target.value)}
              onBlur={() => markTouched('timeoutMs')}
            />
            {showError('timeoutMs') ? (
              <small className="es-error" role="alert">
                {showError('timeoutMs')}
              </small>
            ) : null}
          </div>

          <div className="es-field">
            <label htmlFor={fieldId('temperature')}>Temperature</label>
            <Input
              id={fieldId('temperature')}
              className="es-temperature-input"
              type="text"
              inputMode="decimal"
              pattern={DECIMAL_INPUT_PATTERN}
              value={temperature}
              invalid={Boolean(showError('temperature'))}
              onChange={(e) => setTemperature(normalizeDecimalInput(e.target.value))}
              onBlur={() => markTouched('temperature')}
            />
            {showError('temperature') ? (
              <small className="es-error" role="alert">
                {showError('temperature')}
              </small>
            ) : null}
          </div>

          <div className="es-field">
            <label htmlFor={fieldId('maxTokens')}>Max tokens</label>
            <Input
              id={fieldId('maxTokens')}
              type="number"
              value={maxTokens}
              invalid={Boolean(showError('maxTokens'))}
              onChange={(e) => setMaxTokens(e.target.value)}
              onBlur={() => markTouched('maxTokens')}
            />
            {showError('maxTokens') ? (
              <small className="es-error" role="alert">
                {showError('maxTokens')}
              </small>
            ) : null}
          </div>
        </div>

        {/* Probe result */}
        <div className="es-probe" aria-live="polite">
          <div className="es-probe-result" key={probe.phase}>
            {probe.phase === 'testing' ? <span className="es-probe-testing">Testing…</span> : null}
            {probe.phase === 'verified' ? (
              <span className="es-probe-ok" role="status">
                Verified
                {probe.verifiedAt != null ? ` · ${formatTimestamp(probe.verifiedAt)}` : ''}
              </span>
            ) : null}
            {probe.phase === 'error' ? (
              <span className="es-probe-err" role="alert">
                {probe.message}
              </span>
            ) : null}
          </div>
        </div>

        {/* Outside the live region above: expanding the evidence must not
            re-announce the failure it belongs to. */}
        {probe.phase === 'error' && probe.diagnostic ? (
          <RequestDiagnosticDetails diagnostic={probe.diagnostic} idPrefix={fieldId('probe')} />
        ) : null}

        {formError ? (
          <small className="es-error" role="alert">
            {formError}
          </small>
        ) : null}

        {/* Footer */}
        <div className="es-footer">
          <div className="es-footer-left">
            {isEdit && !confirmingDelete ? (
              <button
                type="button"
                className="es-delete-btn"
                onClick={() => setConfirmingDelete(true)}
              >
                Delete
              </button>
            ) : null}
            {isEdit && confirmingDelete ? (
              <div
                className="es-confirm-delete"
                role="group"
                aria-label="Confirm endpoint deletion"
              >
                <span className="es-confirm-delete-label">Delete this endpoint?</span>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setConfirmingDelete(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void confirmDelete()}
                >
                  Delete
                </Button>
              </div>
            ) : null}
          </div>

          <div className="es-footer-right">
            <Button
              type="button"
              variant="secondary"
              onClick={() => void runProbe()}
              disabled={!canProbe}
            >
              Test probe
            </Button>
            <Button type="submit" variant="primary" disabled={!canSave}>
              Save
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
