# Matching Hello's surface

Start the document with this base so the preview opens dark and quiet:

```html
<style>
  :root {
    color-scheme: dark;
    --bg: #0e0e11; --panel: #16161a; --line: #26262c;
    --text: #e7e7ea; --muted: #9a9aa4; --accent: #7aa2f7;
  }
  body { margin: 0; padding: 24px; background: var(--bg); color: var(--text);
         font: 14px/1.5 -apple-system, "Inter", system-ui, sans-serif; }
  h1 { font-size: 16px; font-weight: 550; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 12px; margin: 0 0 20px; }
  .panel { background: var(--panel); border: 1px solid var(--line);
           border-radius: 12px; padding: 18px; }
  text { fill: var(--text); font-size: 11px; }
  .axis line, .axis path { stroke: var(--line); }
  .muted { fill: var(--muted); }
</style>
```

Keep the title short, put the data source and date in `.sub`, and leave at least
16px between the plot and any label. Bars: `fill: var(--accent)` for the series
being discussed, `#3a3a44` for context series.
