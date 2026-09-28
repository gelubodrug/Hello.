// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanSwitch } from "../src/renderer/workspace/PlanSwitch";

// Plan is switched where its steps would land — on the Tasks tab — and it is
// drawn as a switch, because on and off are not two peers to choose between
// (user, 18.09: "on/off activezi de sus, tasks on off").
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = async (planning: boolean, onChange: (next: boolean) => void) => {
  await act(async () => { root.render(createElement(PlanSwitch, { planning, onChange })); });
  return host.querySelector("button")!;
};
const click = async (node: Element) => {
  await act(async () => { node.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
};

describe("the Plan switch on the Tasks tab", () => {
  it("announces itself as a switch and says which state it is in", async () => {
    const off = await render(false, vi.fn());
    expect(off.getAttribute("role")).toBe("switch");
    expect(off.getAttribute("aria-checked")).toBe("false");
    expect(off.getAttribute("aria-label")).toBe("Plan off — the model writes no steps");
    const on = await render(true, vi.fn());
    expect(on.getAttribute("aria-checked")).toBe("true");
    expect(on.getAttribute("aria-label")).toBe("Plan on — the model writes its steps here");
  });

  it("turns on, turns off, and never opens the page under it", async () => {
    const onChange = vi.fn();
    const opened = vi.fn();
    // The tab is around the switch, so it hears what gets past it.
    document.body.addEventListener("click", opened);
    await click(await render(false, onChange));
    expect(onChange).toHaveBeenCalledWith(true);
    await click(await render(true, onChange));
    expect(onChange).toHaveBeenLastCalledWith(false);
    // The tab around it never hears the click.
    expect(opened).not.toHaveBeenCalled();
    document.body.removeEventListener("click", opened);
  });
});
