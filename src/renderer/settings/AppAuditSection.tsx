import { Anchor, Copy, FolderOpen, HardDrive, Info, Plug, Server, CheckCircle, AlertCircle, Coins, ChevronDown, SunMoon } from 'lucide-react';
import type { AppSettings, UsageSummary } from '../../shared/types';
import { api } from '../api';
import { IconButton, MenuButton } from '../ui/primitives';
import { useEffect, useState } from 'react';
import { dollars, tokens } from '../chat/ContextMeter';
import { modelName } from './presets';

type Appearance = NonNullable<AppSettings['appearance']>;
interface Props {
  dataPath: string;
  version: string;
  endpointUrl: string;
  extensionsLoaded: number;
  /** Light, Dark or as macOS is (audit B2): applied the moment it is chosen. */
  appearance?: Appearance;
  onAppearance?: (appearance: Appearance) => void;
}
const APPEARANCES: Array<{ value: Appearance; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/**
 * What every reply has cost and moved, by model and by chat (user, 04.10, the
 * second design audit: cost lived only inside one chat's meter). Tokens are
 * always shown; cost only where a provider reported one.
 */
function UsageCard({ usage }: { usage: UsageSummary }) {
  const priced = usage.cost > 0;
  const row = (input: number, output: number, cost: number) => <>
    <td>{tokens(input + output)}</td>
    {priced && <td>{cost > 0 ? dollars(cost) : '—'}</td>}
  </>;
  return (
    <div className="audit-card audit-card-wide">
      <div className="audit-card-head">
        <Coins size={16} aria-hidden />
        <span>Usage</span>
      </div>
      <p className="audit-value">
        {priced ? `${dollars(usage.cost)} · ` : ''}{tokens(usage.input)} in · {tokens(usage.output)} out · {usage.replies.toLocaleString()} {usage.replies === 1 ? 'reply' : 'replies'}
      </p>
      <table className="audit-usage" aria-label="Usage by model">
        <thead><tr><th>Model</th><th>Replies</th><th>Tokens</th>{priced && <th>Cost</th>}</tr></thead>
        <tbody>
          {usage.models.slice(0, 6).map(item => (
            <tr key={item.model}><td title={item.model}>{modelName(item.model)}</td><td>{item.replies}</td>{row(item.input, item.output, item.cost)}</tr>
          ))}
        </tbody>
      </table>
      <table className="audit-usage" aria-label="Usage by chat">
        <thead><tr><th>Chat</th><th>Replies</th><th>Tokens</th>{priced && <th>Cost</th>}</tr></thead>
        <tbody>
          {usage.chats.map(item => (
            <tr key={item.conversationId}><td title={item.title}>{item.title}</td><td>{item.replies}</td>{row(item.input, item.output, item.cost)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AppAuditSection({ dataPath, version, endpointUrl, extensionsLoaded, appearance = 'system', onAppearance }: Props) {
  const [copyOk, setCopyOk] = useState(false);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  useEffect(() => {
    let alive = true;
    void api.settings.usage?.().then(value => { if (alive) setUsage(value); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const endpoint = endpointUrl || 'Not configured';
  const endpointOk = !!endpointUrl;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 2000);
    } catch { /* ignore */ }
  };

  return (
    <div className="settings-form">
      <p className="muted">
        Quick entry points to the app's runtime state. No credentials or secrets are shown here.
      </p>

      <div className="audit-grid">
        {onAppearance && (
          <div className="audit-card">
            <div className="audit-card-head">
              <SunMoon size={16} aria-hidden />
              <span>Appearance</span>
            </div>
            <MenuButton label="Appearance" className="settings-select" align="start"
              items={APPEARANCES.map(option => ({ id: option.value, label: option.label, checked: appearance === option.value, action: () => onAppearance(option.value) }))}>
              <span>{APPEARANCES.find(option => option.value === appearance)?.label}</span>
              <ChevronDown size={14} />
            </MenuButton>
          </div>
        )}
        <div className="audit-card">
          <div className="audit-card-head">
            <HardDrive size={16} aria-hidden />
            <span>Data path</span>
          </div>
          <p className="audit-value" title={dataPath}>{dataPath}</p>
          <div className="audit-actions">
            <button className="pill" onClick={() => { void api.system.revealPath(dataPath).catch(() => {}); }}>
              <FolderOpen size={14} aria-hidden />
              Reveal
            </button>
            <IconButton label="Copy data path" onClick={() => void copy(dataPath)}>
              {copyOk ? <CheckCircle size={14} /> : <Copy size={14} />}
            </IconButton>
          </div>
        </div>

        <div className="audit-card">
          <div className="audit-card-head">
            <Info size={16} aria-hidden />
            <span>App version</span>
          </div>
          <p className="audit-value">{version}</p>
        </div>

        <div className="audit-card">
          <div className="audit-card-head">
            <Server size={16} aria-hidden />
            <span>Endpoint</span>
          </div>
          <p className="audit-value" title={endpoint}>{endpoint}</p>
          <span className={`audit-badge${endpointOk ? ' is-ok' : ' is-warn'}`}>
            {endpointOk ? 'Connected' : 'Not set'}
          </span>
        </div>

        <div className="audit-card">
          <div className="audit-card-head">
            <Plug size={16} aria-hidden />
            <span>Extensions</span>
          </div>
          <p className="audit-value">{extensionsLoaded} installed</p>
        </div>

        {usage && usage.replies > 0 && <UsageCard usage={usage} />}
      </div>

      <div className="audit-note">
        <Anchor size={14} aria-hidden />
        <span>Full audit trail and diagnostics are available in the app logs and data directory.</span>
      </div>
    </div>
  );
}