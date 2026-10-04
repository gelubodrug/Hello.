import { ToggleLeft, ToggleRight } from 'lucide-react';

/**
 * On or off for the model: a notebook section (Runbooks, Tasks, Plans) or one
 * of its chapters. On and off are not two peers to pick between, so this is a
 * switch — drawn as one, labelled as one and announced as one.
 *
 * Controlled: it decides nothing, it only reports the click.
 */
export function NotebookSwitch({
  on,
  label,
  disabled = false,
  onChange,
}: {
  on: boolean;
  /** What is switched, said whole: "Runbooks — the model reads them". */
  label: string;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="notebook-switch"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={event => {
        // Inside a row that selects or folds: switching is not choosing.
        event.stopPropagation();
        onChange(!on);
      }}
    >
      {on ? <ToggleRight size={15} aria-hidden /> : <ToggleLeft size={15} aria-hidden />}
    </button>
  );
}
