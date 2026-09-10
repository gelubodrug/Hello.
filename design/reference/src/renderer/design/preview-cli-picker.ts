import { ArrowLeft, Bot } from 'lucide-react';
import { CLI_WORKER_CATALOG, type CliWorkerId } from '../../shared/ipc-contract';
import type { MenuItemDef } from '../ui/Menu';

/** The real catalog, but selection creates only a local preview fixture. */
export function previewCliWorkerItems(
  onChoose: (workerId: CliWorkerId) => void,
  onBack: () => void,
): MenuItemDef[] {
  return [
    { id: 'back', label: 'Back', icon: ArrowLeft, onSelect: onBack },
    ...CLI_WORKER_CATALOG.map((worker, index) => ({
      id: worker.id,
      label: worker.usesActiveModel ? `${worker.label} · active model` : worker.label,
      icon: Bot,
      separatorBefore: index === 0,
      onSelect: () => onChoose(worker.id),
    })),
  ];
}
