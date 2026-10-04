/**
 * The Pi theme, the default of the Pi Hello opens in a tab (user, 01.10).
 * A dark theme: a
 * neutral canvas and one meaning per colour — blue for focus and links, green
 * for done, amber for attention, red for failure — with tool results left on
 * the terminal's own background.
 */
export const PI_THEME_NAME = 'hello';

export const PI_THEME = {
  "$schema": "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "hello",
  "colors": {
    "accent": "#82aaff",
    "border": "#505050",
    "borderAccent": "#82aaff",
    "borderMuted": "#3e3e3e",
    "success": "#7bc8a4",
    "error": "#e06c75",
    "warning": "#e4b66a",
    "muted": "#7a7a7a",
    "dim": "#545454",
    "text": "#d4d4d4",
    "thinkingText": "#7a7a7a",
    "selectedBg": "#2a2a2a",
    "userMessageBg": "",
    "userMessageText": "#d4d4d4",
    "customMessageBg": "",
    "customMessageText": "#d4d4d4",
    "customMessageLabel": "#b9a0ef",
    "toolPendingBg": "",
    "toolSuccessBg": "",
    "toolErrorBg": "",
    "toolTitle": "#d4d4d4",
    "toolOutput": "#7a7a7a",
    "mdHeading": "#82aaff",
    "mdLink": "#82aaff",
    "mdLinkUrl": "#545454",
    "mdCode": "#7dcfff",
    "mdCodeBlock": "#d4d4d4",
    "mdCodeBlockBorder": "#505050",
    "mdQuote": "#7a7a7a",
    "mdQuoteBorder": "#505050",
    "mdHr": "#505050",
    "mdListBullet": "#82aaff",
    "toolDiffAdded": "#7bc8a4",
    "toolDiffRemoved": "#e06c75",
    "toolDiffContext": "#7a7a7a",
    "syntaxComment": "#7a7a7a",
    "syntaxKeyword": "#b9a0ef",
    "syntaxFunction": "#82aaff",
    "syntaxVariable": "#d4d4d4",
    "syntaxString": "#a9c98f",
    "syntaxNumber": "#e4b66a",
    "syntaxType": "#7dcfff",
    "syntaxOperator": "#d4d4d4",
    "syntaxPunctuation": "#7a7a7a",
    "thinkingOff": "#545454",
    "thinkingMinimal": "#7a7a7a",
    "thinkingLow": "#4d618c",
    "thinkingMedium": "#82aaff",
    "thinkingHigh": "#9ea5f7",
    "thinkingXhigh": "#b9a0ef",
    "bashMode": "#7dcfff"
  },
  "export": {
    "pageBg": "#181818",
    "cardBg": "#1c1c1c",
    "infoBg": "#1c1c1c"
  }
};
