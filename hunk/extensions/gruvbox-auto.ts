import { execFileSync } from "node:child_process";
import type { HunkExtensionAPI } from "hunkdiff/extension";

const darkTheme = {
  base: "gruvbox-dark-hard",
  background: "#282828",
  panel: "#3c3836",
  panelAlt: "#504945",
  border: "#665c54",
  accent: "#d79921",
  accentMuted: "#7c6f64",
  text: "#ebdbb2",
  muted: "#a89984",
  addedBg: "#32361a",
  removedBg: "#3c1f1e",
  movedAddedBg: "#2f3b2d",
  movedRemovedBg: "#3b2937",
  contextBg: "#282828",
  addedContentBg: "#3f4a20",
  removedContentBg: "#512522",
  contextContentBg: "#32302f",
  addedSignColor: "#b8bb26",
  removedSignColor: "#fb4934",
  lineNumberBg: "#32302f",
  lineNumberFg: "#928374",
  selectedHunk: "#504945",
  badgeAdded: "#98971a",
  badgeRemoved: "#cc241d",
  badgeNeutral: "#7c6f64",
  fileNew: "#b8bb26",
  fileDeleted: "#fb4934",
  fileRenamed: "#83a598",
  fileModified: "#fabd2f",
  fileUntracked: "#8ec07c",
  noteBorder: "#d3869b",
  noteBackground: "#3b2937",
  noteTitleBackground: "#504945",
  noteTitleText: "#fbf1c7",
} as const;

const lightTheme = {
  base: "gruvbox-light-hard",
  background: "#fbf1c7",
  panel: "#ebdbb2",
  panelAlt: "#d5c4a1",
  border: "#bdae93",
  accent: "#b57614",
  accentMuted: "#a89984",
  text: "#3c3836",
  muted: "#7c6f64",
  addedBg: "#e5e6c3",
  removedBg: "#f1d2bd",
  movedAddedBg: "#d9e1c0",
  movedRemovedBg: "#ead0db",
  contextBg: "#fbf1c7",
  addedContentBg: "#d8dca8",
  removedContentBg: "#e9b9a5",
  contextContentBg: "#f2e5bc",
  addedSignColor: "#79740e",
  removedSignColor: "#9d0006",
  lineNumberBg: "#ebdbb2",
  lineNumberFg: "#928374",
  selectedHunk: "#d5c4a1",
  badgeAdded: "#79740e",
  badgeRemoved: "#9d0006",
  badgeNeutral: "#a89984",
  fileNew: "#79740e",
  fileDeleted: "#9d0006",
  fileRenamed: "#076678",
  fileModified: "#b57614",
  fileUntracked: "#427b58",
  noteBorder: "#8f3f71",
  noteBackground: "#ead0db",
  noteTitleBackground: "#d5c4a1",
  noteTitleText: "#3c3836",
} as const;

function macOSUsesDarkAppearance(): boolean {
  if (process.platform !== "darwin") return true;

  try {
    return execFileSync(
      "/usr/bin/defaults",
      ["read", "-g", "AppleInterfaceStyle"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim() === "Dark";
  } catch {
    // `defaults` exits non-zero when AppleInterfaceStyle is absent, which is
    // how macOS represents Light appearance.
    return false;
  }
}

export default function registerGruvboxAuto(hunk: HunkExtensionAPI) {
  const dark = macOSUsesDarkAppearance();

  hunk.registerTheme({
    id: "gruvbox-auto",
    label: `Gruvbox Auto (${dark ? "Dark" : "Light"})`,
    ...(dark ? darkTheme : lightTheme),
  });
}
