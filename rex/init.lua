-- Keybindings ported from Ghostty (ghostty/config) so pane and text
-- shortcuts behave the same in Rex.

-- Alt+Left / Alt+Right: move by word backward / forward.
-- Ghostty sends ESC+b / ESC+f; pass the same escape sequences through.
rex.bind("alt+left", "pane.send_key", { key = "alt+b" })
rex.bind("alt+right", "pane.send_key", { key = "alt+f" })

-- Ctrl+Shift+[ / Ctrl+Shift+]: navigate between panes (Ghostty goto_split).
-- On a US layout [ and ] are shift+bracket keys; use physical BracketLeft/
-- BracketRight codes so the binding follows the key, not the character.
rex.bind("ctrl+shift+[BracketLeft]", "pane.focus_previous")
rex.bind("ctrl+shift+[BracketRight]", "pane.focus_next")

-- Shift+Enter sends ESC+CR (same as Ghostty's text:\x1b\r), useful in editors
-- that distinguish shift+enter from enter.
rex.bind("shift+enter", "pane.send_key", { key = "escape+enter" })

-- rex-butler auto-start: ensure the butler's master session exists on load.
-- The config file runs in the server process, whose PATH may not include
-- user-local bins; use the rex binary's absolute path (versions directory).
local function rex_bin()
  local path = os.getenv("PATH") or ""
  -- try PATH first, then the known server install location
  local f = io.open("/Users/kayiranga/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex", "r")
  if f then f:close()
    return "/Users/kayiranga/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex"
  end
  return "rex"
end
rex.exec({ rex_bin(), "do", os.getenv("HOME") .. "/Documents/rex-butler/lua/bootstrap.lua", "agent=pi" },
         { timeout = 30, stdout = false, stderr = false, detach = false })
