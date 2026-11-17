import JSZip from 'jszip';
import { cellName, type SheetChart } from '../../shared/sheets';

/**
 * The charts a workbook file holds, read from the package itself: which sheet,
 * what kind, its title, where it is anchored and which cells it draws. Hello
 * does not draw charts and its reader does not load them, so this is the only
 * way the model — or anyone — learns what a script actually left in the file
 * without unpacking it by hand (a model did exactly that, and lost half a task
 * to a duplicated chart it could not see).
 */
const KINDS = ['bar', 'bar3D', 'pie', 'pie3D', 'doughnut', 'line', 'line3D', 'area', 'area3D', 'scatter', 'bubble', 'radar', 'surface', 'stock', 'ofPie'];
const text = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
/** A part named by a relationship: absolute from the package root, or relative to the part that names it. */
const resolve = (from: string, target: string) => {
  if (target.startsWith('/')) return target.slice(1);
  const parts = from.split('/').slice(0, -1);
  for (const piece of target.split('/')) { if (piece === '..') parts.pop(); else if (piece !== '.') parts.push(piece); }
  return parts.join('/');
};
const relsOf = (part: string) => { const at = part.lastIndexOf('/'); return `${part.slice(0, at)}/_rels/${part.slice(at + 1)}.rels`; };
function relationships(xml: string | undefined): Map<string, { target: string; type: string }> {
  const found = new Map<string, { target: string; type: string }>();
  for (const [tag] of (xml ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]*)"/.exec(tag)?.[1], target = /\bTarget="([^"]*)"/.exec(tag)?.[1], type = /\bType="([^"]*)"/.exec(tag)?.[1] ?? '';
    if (id && target) found.set(id, { target: text(target), type });
  }
  return found;
}

export async function chartsIn(bytes: Uint8Array): Promise<SheetChart[]> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); } catch { return []; }
  const read = (name: string) => zip.files[name]?.async('string');
  const workbook = await read('xl/workbook.xml');
  if (!workbook) return [];
  const sheetParts = relationships(await read('xl/_rels/workbook.xml.rels'));
  const charts: SheetChart[] = [];
  for (const [tag] of workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(tag)?.[1], rel = /\br:id="([^"]*)"/.exec(tag)?.[1];
    const part = rel && sheetParts.get(rel);
    if (!name || !part) continue;
    const sheetPart = resolve('xl/workbook.xml', part.target);
    for (const drawingRel of relationships(await read(relsOf(sheetPart))).values()) {
      if (!/\/drawing$/.test(drawingRel.type)) continue;
      const drawingPart = resolve(sheetPart, drawingRel.target);
      const drawing = await read(drawingPart);
      if (!drawing) continue;
      const chartParts = relationships(await read(relsOf(drawingPart)));
      // One anchor per thing drawn; only those that point at a chart count.
      for (const [anchor] of drawing.matchAll(/<(?:\w+:)?(oneCellAnchor|twoCellAnchor|absoluteAnchor)\b[\s\S]*?<\/(?:\w+:)?\1>/g)) {
        const chartRel = /<(?:\w+:)?chart\b[^>]*\br:id="([^"]*)"/.exec(anchor)?.[1];
        const chartPart = chartRel && chartParts.get(chartRel);
        if (!chartPart) continue;
        const xml = await read(resolve(drawingPart, chartPart.target));
        if (!xml) continue;
        const from = /<(?:\w+:)?from>[\s\S]*?<(?:\w+:)?col>(\d+)<[\s\S]*?<(?:\w+:)?row>(\d+)</.exec(anchor);
        const kind = KINDS.find(item => new RegExp(`<(?:\\w+:)?${item}Chart\\b`).test(xml));
        const title = /<(?:\w+:)?title>([\s\S]*?)<\/(?:\w+:)?title>/.exec(xml)?.[1];
        const words = title ? [...title.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(match => text(match[1])).join('').trim() : '';
        const refs = (within: string) => [...new Set([...xml.matchAll(new RegExp(`<(?:\\w+:)?${within}>[\\s\\S]*?<(?:\\w+:)?f>([^<]*)</(?:\\w+:)?f>[\\s\\S]*?</(?:\\w+:)?${within}>`, 'g'))].map(match => text(match[1])))];
        charts.push({
          sheet: text(name), type: kind ?? 'chart', ...(words ? { title: words } : {}),
          ...(from ? { anchor: cellName(Number(from[2]) + 1, Number(from[1]) + 1) } : {}),
          values: [...refs('val'), ...refs('yVal')].slice(0, 12), categories: [...refs('cat'), ...refs('xVal')].slice(0, 4),
          ...(/<(?:\w+:)?cat>\s*<(?:\w+:)?(?:strRef|multiLvlStrRef)\b/.test(xml) ? { labelsAs: 'text' as const }
            : /<(?:\w+:)?cat>\s*<(?:\w+:)?numRef\b/.test(xml) ? { labelsAs: 'numbers' as const } : {}),
          cached: /<(?:\w+:)?numCache>[\s\S]*?<(?:\w+:)?pt\b/.test(xml),
        });
      }
    }
  }
  return charts;
}

/**
 * What a workbook file holds, without opening it as a workbook: its sheets by
 * name and how many charts. Enough for a model to see that a file was worked
 * on before — a "Pivot" sheet and a chart from an earlier run — before it
 * opens the file and makes them again.
 */
export async function outlineOf(bytes: Uint8Array): Promise<{ sheets: string[]; charts: number } | null> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const workbook = await zip.files['xl/workbook.xml']?.async('string');
    if (!workbook) return null;
    const sheets = [...workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*\bname="([^"]*)"/g)].map(match => text(match[1]));
    return { sheets, charts: Object.keys(zip.files).filter(name => /^xl\/charts\/chart[^/]*\.xml$/.test(name)).length };
  } catch { return null; }
}

/** Charts of one sheet that draw the same cells as the same kind of chart: one of each pair is almost always a leftover. */
export function repeatedCharts(charts: SheetChart[]): SheetChart[] {
  const seen = new Set<string>();
  const repeated: SheetChart[] = [];
  for (const chart of charts) {
    const same = JSON.stringify([chart.sheet, chart.type, chart.values, chart.categories]);
    if (seen.has(same)) repeated.push(chart); else seen.add(same);
  }
  return repeated;
}

/**
 * The program that puts one chart in a sheet. It is Hello's own and fixed: what
 * the model chose arrives as data (a JSON string the program parses), never as
 * code. A chart already at the anchor is taken out first, so asking again
 * changes the chart instead of stacking a second one on it.
 */
export function chartScript(chart: { sheet: string; type: string; categories: string; values: string; title: string; anchor: string;
  /** The sheet the chart sits on, when it is not the one that holds the cells. */
  into?: string;
  /** What those cells hold now, as Hello computed them: written into the chart so it draws anywhere. */
  labels?: string[]; numbers?: number[];
  /** A small table to write first, on the chart's sheet — the largest groups and the rest as one — which the chart then draws. */
  table?: { row: number; column: number; rows: Array<Array<string | number>>; clear: number } }): string {
  return [
    'import json, openpyxl',
    'from openpyxl.chart import BarChart, LineChart, PieChart, Reference',
    'from openpyxl.chart.data_source import AxDataSource, NumData, NumVal, StrData, StrRef, StrVal',
    'from openpyxl.chart.label import DataLabelList',
    'from openpyxl.styles import Font',
    'from openpyxl.utils.cell import coordinate_from_string, column_index_from_string',
    `P = json.loads(${JSON.stringify(JSON.stringify(chart))})`,
    'wb = openpyxl.load_workbook(WORKBOOK)',
    'home = P.get("into") or P["sheet"]',
    'ws = wb[home] if home in wb.sheetnames else wb.create_sheet(home)',
    'table = P.get("table")',
    'if table:',
    '    for y, line in enumerate(table["rows"]):',
    '        for x, value in enumerate(line):',
    '            ws.cell(row=table["row"] + y, column=table["column"] + x, value=value)',
    '    for x in range(len(table["rows"][0])):',
    '        ws.cell(row=table["row"], column=table["column"] + x).font = Font(bold=True)',
    // What an earlier, longer table left under this one.
    '    for y in range(len(table["rows"]), len(table["rows"]) + table["clear"]):',
    '        for x in range(len(table["rows"][0])):',
    '            ws.cell(row=table["row"] + y, column=table["column"] + x).value = None',
    'def place(chart):',
    '    anchor = chart.anchor',
    '    if isinstance(anchor, str):',
    '        column, row = coordinate_from_string(anchor)',
    '        return (column_index_from_string(column) - 1, row - 1)',
    '    start = getattr(anchor, "_from", None)',
    '    return (start.col, start.row) if start is not None else None',
    'column, row = coordinate_from_string(P["anchor"])',
    'spot = (column_index_from_string(column) - 1, row - 1)',
    'ws._charts = [chart for chart in ws._charts if place(chart) != spot]',
    'kind = P["type"]',
    'chart = PieChart() if kind == "pie" else LineChart() if kind == "line" else BarChart()',
    'if kind == "bar": chart.type = "bar"',
    'if kind == "column": chart.type = "col"',
    'if P["title"]: chart.title = P["title"]',
    'name = "\'" + P["sheet"].replace("\'", "\'\'") + "\'!"',
    'chart.add_data(Reference(range_string=name + P["values"]), titles_from_data=False)',
    'chart.set_categories(Reference(range_string=name + P["categories"]))',
    // As Excel itself writes a chart: labels are text (openpyxl would file them
    // as numbers), and the values travel with it, so the chart is whole in any
    // viewer and not only after a recalculation.
    'series = chart.series[0]',
    'labels, numbers = P.get("labels"), P.get("numbers")',
    'where = series.cat.numRef.f',
    'cache = StrData(ptCount=len(labels), pt=[StrVal(idx=i, v=str(v)) for i, v in enumerate(labels)]) if labels else None',
    'series.cat = AxDataSource(strRef=StrRef(f=where, strCache=cache))',
    'if numbers:',
    '    series.val.numRef.numCache = NumData(formatCode="General", ptCount=len(numbers), pt=[NumVal(idx=i, v=repr(v)) for i, v in enumerate(numbers)])',
    'if kind == "pie":',
    '    chart.dataLabels = DataLabelList()',
    '    chart.dataLabels.showPercent = True',
    // Said outright: left unsaid, Excel also prints the series name, the value and the legend key on every slice.
    '    chart.dataLabels.showVal = False',
    '    chart.dataLabels.showSerName = False',
    '    chart.dataLabels.showCatName = False',
    '    chart.dataLabels.showLegendKey = False',
    'else:',
    '    chart.legend = None',
    // Said outright, each of them: left unsaid, Excel rounds the frame, lets the
    // legend and the title sit over the plot, and openpyxl 3.1 leaves the axes out.
    'chart.roundedCorners = False',
    'if chart.legend is not None: chart.legend.overlay = False',
    'if chart.title is not None: chart.title.overlay = False',
    'for axis in ("x_axis", "y_axis"):',
    '    if hasattr(chart, axis): getattr(chart, axis).delete = False',
    'chart.width, chart.height = 18, 10',
    'ws.add_chart(chart, P["anchor"])',
    // openpyxl does not read the frame's corners back: every chart it loaded would be saved rounded again.
    'for sheet in wb.worksheets:',
    '    for held in sheet._charts: held.roundedCorners = False',
    'wb.save(WORKBOOK)',
    'print("chart placed")',
  ].join('\n');
}
