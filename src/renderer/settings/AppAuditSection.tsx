import { Anchor, Copy, FolderOpen, HardDrive, Info, Plug, Server, CheckCircle, AlertCircle } from 'lucide-react';
import { api } from '../api';
import { IconButton } from '../ui/primitives';
import { useState } from 'react';

interface Props {
  dataPath: string;
  version: string;
  endpointUrl: string;
  extensionsLoaded: number;
}

export function AppAuditSection({ dataPath, version, endpointUrl, extensionsLoaded }: Props) {
  const [copyOk, setCopyOk] = useState(false);
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
      </div>

      <div className="audit-note">
        <Anchor size={14} aria-hidden />
        <span>Full audit trail and diagnostics are available in the app logs and data directory.</span>
      </div>
    </div>
  );
}