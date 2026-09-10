---
name: text-review
description: Review a draft for length, repetition and unsupported claims using the text_stats tool from this plugin. Use when the user asks whether a text is too long, repetitive or vague.
version: 1.0.0
---

# Text review

1. Run `text_stats` on the draft with `top: 12`.
2. Read the counts before judging: a "too long" complaint about 300 words is
   about structure, not length.
3. Name the three most repeated meaningful terms and check whether each repeat
   earns its place.
4. Flag every sentence that asserts a number, date or outcome with no source in
   the conversation.
5. Answer with: the measured shape, the two changes with the largest effect, and
   what you did not check.

Report the numbers the tool returned. Do not estimate them yourself.
