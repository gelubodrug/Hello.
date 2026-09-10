---
name: hello-visuals
description: Build a self-contained HTML visual (chart, diagram, comparison table, small interactive explainer) and open it inside Hello's own Browser. Use when the user asks to see, chart, plot, diagram, visualise or compare data instead of reading prose.
version: 1.0.0
---

# Hello Visuals

Make one honest, readable visual from data that already exists in this
conversation, and open it in Hello's Browser with `browser_show_html`.

## When to use

- "chart this", "plot", "graph", "visualise", "show me", "diagram", "timeline"
- a comparison the reader would understand faster as a table or small-multiple
- a short interactive explainer (a slider, a toggle between two views)

Do not use it to decorate an answer that is already clear in two sentences.

## Steps

1. **Collect the real values first.** Use only numbers the user supplied, a tool
   returned, or a page you actually read with `fetch_url`. If a value is
   missing, say so in the visual instead of inventing it.
2. **Pick the form** with `references/forms.md`: it maps a question to a chart
   type and names the traps for each one.
3. **Write one complete HTML document** and pass it to `browser_show_html`:
   inline `<style>`, inline SVG or `<canvas>`, no external scripts, fonts or
   chart CDNs, no network requests. Keep it under roughly 400 lines.
4. **Match Hello's dark surface** using the palette in
   `references/style.md` so the preview does not flash white.
5. **Say what it shows and what it does not.** Opening a preview is not
   verification: report that you created it, name the data source, and name any
   value you left out.

## Rules that keep it honest

- Axis, labels and units must agree with the data. No invented hourly points
  from a daily minimum and maximum.
- Zero-based axis for bars. A truncated axis for a line must be labelled.
- Never send the user's data to an external chart service.
- If the user asks for a change, edit and re-open with `browser_show_html`;
  do not create a second unrelated file.
