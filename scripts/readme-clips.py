#!/usr/bin/env python3
"""The README's clips: four seconds each, drawn — not recorded — in Hello's own
dark tokens, of things the app does. One animated SVG per scenario, written to
assets/readme/. A scenario is a list of things and the moment each appears.

  python3 scripts/readme-clips.py            write the clips
  python3 scripts/readme-clips.py --at 2.4   the same, stopped at that second (to look at a moment)
"""
import os, sys
from html import escape

W, H, LOOP = 960, 540, 4.0
SIDEBAR, PANEL, RAISED, ACTIVE, EDGE = '#111111', '#181818', '#222222', '#363636', '#2e2e2e'
INK, INK2, INK3, MARK, BLUE = '#e6e6e6', '#b3b3b3', '#969696', '#ffd23f', '#5b9dff'
SANS = "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
CHAT = (14, 14, 392, 512)      # the chat card
TOOLS = (418, 14, 528, 512)    # the card beside it


class Clip:
    def __init__(self):
        self.parts, self.frames = [], set()

    def at(self, start, end=None):
        """The class of a thing that appears at `start` seconds and stays, or leaves at `end`."""
        a = round(start / LOOP * 100)
        b = 95 if end is None else round(end / LOOP * 100)
        self.frames.add((a, b))
        return f'class="k{a}_{b}"'

    def add(self, *parts):
        self.parts.extend(parts)

    def text(self, x, y, words, size: float = 13, fill=INK, weight=400, anchor='start', font=SANS, cls=''):
        self.add(f'<text x="{x}" y="{y}" font-family="{font}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}" {cls}>{escape(words)}</text>')

    def pill(self, x, y, w, label, active=False, icon='', cls=''):
        self.add(f'<g {cls}><rect x="{x}" y="{y}" width="{w}" height="28" rx="14" fill="{ACTIVE if active else SIDEBAR}"/>'
                 f'{icon_at(icon, x + 16, y + 14, INK if active else INK3)}'
                 f'<text x="{x + (30 if icon else 14)}" y="{y + 18.5}" font-family="{SANS}" font-size="13" fill="{INK if active else INK3}">{escape(label)}</text></g>')

    def cards(self):
        for x, y, w, h in (CHAT, TOOLS):
            self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="18" fill="{PANEL}"/>')
        x, y, w, h = CHAT
        self.pill(x + 12, y + 12, 76, 'Chat', True, 'chat')
        # the composer
        self.add(f'<rect x="{x + 12}" y="{y + h - 76}" width="{w - 24}" height="64" rx="16" fill="{RAISED}"/>')
        self.text(x + 28, y + h - 48, 'Ask anything', 13, '#6b6b6b')
        self.add(f'<circle cx="{x + w - 34}" cy="{y + h - 30}" r="11" fill="{ACTIVE}"/><path d="M{x + w - 34} {y + h - 25}v-10m-4 4 4-4 4 4" stroke="{INK2}" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>')

    def asked(self, lines):
        """The person's message, top right of the chat."""
        x, y, w, _ = CHAT
        width = max(len(line) for line in lines) * 6.6 + 28
        height = 18 * len(lines) + 18
        left = x + w - 14 - width
        self.add(f'<rect x="{left:.0f}" y="{y + 56}" width="{width:.0f}" height="{height}" rx="14" fill="{RAISED}"/>')
        for index, line in enumerate(lines):
            self.text(left + 14, y + 79 + 18 * index, line, 13, INK)
        return y + 56 + height + 26

    def did(self, y, words, start):
        """One line of the chat's Activity, as the app words it."""
        self.add(f'<text x="{CHAT[0] + 16}" y="{y}" font-family="{SANS}" font-size="13" fill="{INK3}" {self.at(start)}>{escape(words)}<tspan dx="7" fill="#6b6b6b">›</tspan></text>')
        return y + 24

    def said(self, y, lines, start, step=0.12):
        for index, line in enumerate(lines):
            self.text(CHAT[0] + 16, y + 20 * index, line, 13.5, INK, cls=self.at(start + step * index))

    def svg(self, label, freeze=None):
        style = [f'@keyframes k{a}_{b}{{0%,{a}%{{opacity:0}}{min(a + 3, b)}%,{b}%{{opacity:1}}{min(b + 4, 100)}%,100%{{opacity:0}}}}'
                 f'.k{a}_{b}{{animation:k{a}_{b} {LOOP}s linear infinite}}' for a, b in sorted(self.frames)]
        style.append('@media (prefers-reduced-motion:reduce){[class^="k"]{animation:none}}')
        if freeze is not None:
            style.append(f'[class^="k"]{{animation-play-state:paused!important;animation-delay:-{freeze}s!important}}')
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="{escape(label)}">\n'
                f'<style>{"".join(style)}</style>\n'
                f'<rect width="{W}" height="{H}" rx="22" fill="{SIDEBAR}"/>\n' + '\n'.join(self.parts) + '\n</svg>\n')


def icon_at(kind, cx, cy, color):
    s = f'stroke="{color}" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"'
    if kind == 'chat':
        return f'<path d="M{cx - 5} {cy + 5}l1.2-3.2a5.6 5.6 0 1 1 2.2 2.1z" {s}/>'
    if kind == 'globe':
        return f'<circle cx="{cx}" cy="{cy}" r="5.6" {s}/><ellipse cx="{cx}" cy="{cy}" rx="2.4" ry="5.6" {s}/><path d="M{cx - 5.6} {cy}h11.2" {s}/>'
    if kind == 'bot':
        return f'<rect x="{cx - 5.5}" y="{cy - 3}" width="11" height="8" rx="2" {s}/><path d="M{cx} {cy - 3}v-2.5M{cx - 2.2} {cy + 1}v.1M{cx + 2.2} {cy + 1}v.1" {s}/>'
    return ''


def browser(clip, address, mode, cls=''):
    """A browser tab in the Tools card: its pill, its address bar with the agent's control, its page."""
    x, y, w, h = TOOLS
    clip.add(f'<g {cls}>')
    clip.add(f'<rect x="{x + 12}" y="{y + 50}" width="{w - 24}" height="30" rx="15" fill="{SIDEBAR}"/>')
    clip.text(x + 30, y + 70, address, 12.5, INK2)
    clip.add(f'<rect x="{x + w - 106}" y="{y + 54}" width="88" height="22" rx="11" fill="{ACTIVE}"/>')
    clip.text(x + w - 62, y + 69.5, f'Agent: {mode}', 11.5, INK, anchor='middle')
    clip.add(f'<rect x="{x + 12}" y="{y + 90}" width="{w - 24}" height="{h - 102}" rx="12" fill="#f4f4f2"/>')
    clip.add('</g>')
    return x + 12, y + 90, w - 24, h - 102


def marked_page():
    c = Clip()
    c.cards()
    y = c.asked(['Find the cheapest MacBooks with 256 GB', 'and mark the top three on the page'])
    y = c.did(y, 'Opened in browser', 0.3)
    y = c.did(y, 'Read open page', 0.8)
    y = c.did(y, 'Clicked “Price: lowest first”', 1.3)
    y = c.did(y, 'Marked the page for you', 2.0)
    c.said(y + 10, ['The three cheapest are marked on the page.', 'The first one is $612, used, 16 GB of memory.'], 2.9)
    x, top = TOOLS[0], TOOLS[1]
    c.pill(x + 12, top + 12, 150, 'Laptops · Market', True, 'globe', c.at(0.3))
    px, py, pw, ph = browser(c, 'market.example/laptops?storage=256', 'Full', c.at(0.3))
    c.add(f'<g {c.at(0.45)}>')
    c.text(px + 18, py + 30, 'MacBook, 256 GB', 16, '#1a1a1a', 600)
    c.add(f'<rect x="{px + pw - 170}" y="{py + 14}" width="152" height="24" rx="6" fill="#ffffff" stroke="#d8d8d4"/>')
    c.text(px + pw - 94, py + 30.5, 'Sort', 11.5, '#666666', anchor='end')
    c.text(px + pw - 88, py + 30.5, 'Best match', 11.5, '#1a1a1a', cls=c.at(0.45, 1.4))
    c.text(px + pw - 88, py + 30.5, 'Lowest first', 11.5, '#1a1a1a', cls=c.at(1.45))
    before = ['$890', '$612', '$1,049', '$655', '$779', '$640']
    after = ['$612', '$640', '$655', '$779', '$890', '$1,049']
    cw, ch, gap = (pw - 36 - 2 * 12) / 3, 168, 12
    for index in range(6):
        cx, cy = px + 18 + (index % 3) * (cw + gap), py + 52 + (index // 3) * (ch + gap)
        c.add(f'<rect x="{cx:.0f}" y="{cy}" width="{cw:.0f}" height="{ch}" rx="8" fill="#ffffff" stroke="#e2e2de"/>'
              f'<rect x="{cx + 10:.0f}" y="{cy + 10}" width="{cw - 20:.0f}" height="84" rx="5" fill="#e9e9e5"/>'
              f'<rect x="{cx + cw / 2 - 30:.0f}" y="{cy + 34}" width="60" height="38" rx="3" fill="#cfcfca"/>'
              f'<rect x="{cx + cw / 2 - 38:.0f}" y="{cy + 72}" width="76" height="4" rx="2" fill="#bdbdb8"/>'
              f'<rect x="{cx + 10:.0f}" y="{cy + 106}" width="{cw - 46:.0f}" height="7" rx="3.5" fill="#d6d6d1"/>'
              f'<rect x="{cx + 10:.0f}" y="{cy + 120}" width="{cw - 78:.0f}" height="7" rx="3.5" fill="#e3e3df"/>')
        c.text(cx + 10, cy + 152, before[index], 15, '#1a1a1a', 600, cls=c.at(0.45, 1.4))
        c.text(cx + 10, cy + 152, after[index], 15, '#1a1a1a', 600, cls=c.at(1.45))
    c.add('</g>')
    for index in range(3):
        cx, cy = px + 18 + index * (cw + gap), py + 52
        c.add(f'<g {c.at(2.0 + 0.25 * index)}><rect x="{cx - 3:.0f}" y="{cy - 3}" width="{cw + 6:.0f}" height="{ch + 6}" rx="10" fill="none" stroke="{MARK}" stroke-width="3"/>'
              f'<circle cx="{cx + 4:.0f}" cy="{cy + 4}" r="12" fill="{MARK}"/>')
        c.text(cx + 4, cy + 9, str(index + 1), 13.5, '#111111', 700, anchor='middle')
        c.add('</g>')
    return c, 'Hello. opens a shop page, sorts it by price and marks the three cheapest laptops on the page.'


def asked_a_cli():
    c = Clip()
    c.cards()
    y = c.asked(['Ask Codex to review the plan, then', 'post the short version on Reddit'])
    y = c.did(y, 'Opened Codex CLI', 0.3)
    y = c.did(y, 'Said “Review PLAN.md: what is missing?” to a worker', 0.7)
    y = c.did(y, 'Waited for the worker', 1.3)
    y = c.did(y, 'Opened in browser', 2.2)
    y = c.did(y, 'Typed text', 2.7)
    c.said(y + 10, ['Codex found two gaps. The post is written;', 'it is yours to send.'], 3.1)
    x, top, w, h = TOOLS
    c.pill(x + 12, top + 12, 112, 'Codex CLI', True, 'bot', c.at(0.3, 2.15))
    c.pill(x + 12, top + 12, 112, 'Codex CLI', False, 'bot', c.at(2.2))
    c.pill(x + 130, top + 12, 132, 'Submit · Reddit', True, 'globe', c.at(2.2))
    # the terminal
    c.add(f'<g {c.at(0.3, 2.15)}><rect x="{x + 12}" y="{top + 50}" width="{w - 24}" height="{h - 62}" rx="12" fill="#0c0c0c"/>')
    c.text(x + 30, top + 82, '>_ OpenAI Codex', 13, INK, 600, font=MONO)
    c.add('</g>')
    lines = [(0.7, '› Review PLAN.md: what is missing?', INK2), (1.1, '• Reading PLAN.md', INK3), (1.4, '• Two gaps:', INK),
             (1.55, '  1. no rollback step after the migration', INK), (1.7, '  2. step 4 has no owner', INK), (1.9, '✓ Reported to the chat', '#7ad491')]
    for index, (start, words, color) in enumerate(lines):
        c.text(x + 30, top + 116 + 24 * index, words, 12.5, color, font=MONO, cls=c.at(start, 2.15))
    # the post, in a tab the person is signed in to
    px, py, pw, ph = browser(c, 'reddit.com/submit', 'Full', c.at(2.2))
    c.add(f'<g {c.at(2.25)}>')
    c.text(px + 22, py + 36, 'Create post', 17, '#1a1a1a', 600)
    c.add(f'<rect x="{px + 22}" y="{py + 54}" width="{pw - 44}" height="38" rx="8" fill="#ffffff" stroke="#d8d8d4"/>'
          f'<rect x="{px + 22}" y="{py + 104}" width="{pw - 44}" height="190" rx="8" fill="#ffffff" stroke="#d8d8d4"/>'
          f'<rect x="{px + pw - 104}" y="{py + 310}" width="82" height="32" rx="16" fill="#1a1a1a"/>')
    c.text(px + pw - 63, py + 331, 'Post', 13, '#ffffff', 600, anchor='middle')
    c.add('</g>')
    c.text(px + 36, py + 78, 'Two gaps in our migration plan', 13.5, '#1a1a1a', 600, cls=c.at(2.7))
    for index, words in enumerate(['A second reader went through the plan and found:', '1. no rollback step after the migration', '2. step 4 has no owner', 'Fixing both before we start.']):
        c.text(px + 36, py + 132 + 24 * index, words, 13, '#333333', cls=c.at(2.85 + 0.1 * index))
    return c, 'Hello. asks a CLI agent beside the chat to review a plan, then writes the post in a browser tab.'


def read_my_feed():
    c = Clip()
    c.cards()
    y = c.asked(['Read the latest posts on my Reddit', 'and tell me what matters'])
    y = c.did(y, 'Checked open tabs', 0.3)
    y = c.did(y, 'Read open page', 0.8)
    c.said(y + 10, ['Four new posts since yesterday. Two matter:', '• a faster build of the engine you run', '• a thread asking the question you asked',
                    'The other two are benchmarks you have seen.'], 2.3, 0.2)
    x, top, w, h = TOOLS
    c.pill(x + 12, top + 12, 136, 'Home · Reddit', True, 'globe')
    px, py, pw, ph = browser(c, 'reddit.com/new', 'Read')
    c.add(f'<circle cx="{px + pw - 30}" cy="{py + 28}" r="12" fill="#d9d9d4"/><circle cx="{px + pw - 30}" cy="{py + 25}" r="4.5" fill="#a9a9a4"/><path d="M{px + pw - 38} {py + 36}a8 6 0 0 1 16 0z" fill="#a9a9a4"/>')
    c.text(px + 22, py + 34, 'New', 17, '#1a1a1a', 600)
    posts = [('A faster build of the engine', '2 h'), ('Which context size for long chats?', '5 h'), ('Benchmarks on the new laptops', '9 h'), ('Benchmarks, part two', '14 h')]
    for index, (title, age) in enumerate(posts):
        ty = py + 54 + index * 88
        c.add(f'<rect x="{px + 18}" y="{ty}" width="{pw - 36}" height="76" rx="10" fill="#ffffff" stroke="#e2e2de"/>'
              f'<path d="M{px + 36} {ty + 32}l6-7 6 7z" fill="#bdbdb8"/><path d="M{px + 36} {ty + 44}l6 7 6-7z" fill="#d6d6d1"/>'
              f'<rect x="{px + 66}" y="{ty + 46}" width="{pw - 190}" height="6" rx="3" fill="#e3e3df"/>'
              f'<rect x="{px + 66}" y="{ty + 58}" width="{pw - 280}" height="6" rx="3" fill="#ecece8"/>')
        c.text(px + 66, ty + 32, title, 14, '#1a1a1a', 600)
        c.text(px + pw - 34, ty + 32, age, 11.5, '#8a8a85', anchor='end')
        # the agent reading it, one post after another
        c.add(f'<rect x="{px + 16}" y="{ty - 2}" width="{pw - 32}" height="80" rx="11" fill="{BLUE}" fill-opacity="0.10" stroke="{BLUE}" stroke-width="2" {c.at(0.8 + 0.32 * index, 1.12 + 0.32 * index)}/>')
    for index in (0, 1):
        ty = py + 54 + index * 88
        c.add(f'<rect x="{px + 16}" y="{ty - 2}" width="{pw - 32}" height="80" rx="11" fill="none" stroke="{MARK}" stroke-width="3" {c.at(2.5 + 0.2 * index)}/>')
    return c, 'In a tab where you are signed in and let it read, Hello. reads your latest posts and says which matter.'


def main():
    freeze = float(sys.argv[sys.argv.index('--at') + 1]) if '--at' in sys.argv else None
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'readme')
    if '--out' in sys.argv:
        out = sys.argv[sys.argv.index('--out') + 1]
    os.makedirs(out, exist_ok=True)
    for name, scene in (('clip-marked-page', marked_page), ('clip-asked-a-cli', asked_a_cli), ('clip-read-my-feed', read_my_feed)):
        clip, label = scene()
        with open(os.path.join(out, f'{name}.svg'), 'w', encoding='utf-8') as handle:
            handle.write(clip.svg(label, freeze))
    print('wrote 3 clips to', out)


main()
