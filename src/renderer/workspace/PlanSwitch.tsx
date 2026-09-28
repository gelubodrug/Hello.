import { ToggleLeft, ToggleRight } from 'lucide-react';

/**
 * Whether the model writes its plan into Tasks, switched where the plan would
 * land: on the Tasks page tab itself (user, 18.09). On and off are not two
 * peers to pick between, so this is a switch — drawn as one, labelled as one,
 * and announced as one — not a pair of icons a reader has to interpret.
 *
 * Controlled: it decides nothing, it only reports the click.
 */
export function PlanSwitch({
  planning,
  disabled = false,
  onChange,
}: {
  planning: boolean;
  disabled?: boolean;
  onChange: (planning: boolean) => void;
}) {
  const label = planning
    ? 'Plan on — the model writes its steps here'
    : 'Plan off — the model writes no steps';
  return (
    <button
      type="button"
      className="plan-switch"
      role="switch"
      aria-checked={planning}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={event => {
        // The switch lives inside the page tab; turning it on is not opening
        // the page, and opening the page is not turning it on.
        event.stopPropagation();
        onChange(!planning);
      }}
    >
      {planning ? <ToggleRight size={15} aria-hidden /> : <ToggleLeft size={15} aria-hidden />}
    </button>
  );
}
