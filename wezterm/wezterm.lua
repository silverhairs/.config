local wezterm = require 'wezterm'

local config = wezterm.config_builder()

config.initial_cols = 120
config.font = wezterm.font 'Iosevka'
config.font_size = 15

config.color_scheme = 'Gruvbox dark, hard (base16)'
config.macos_window_background_blur = 65
config.window_background_opacity = 0.85

config.keys = {
  {
    key = 'r',
    mods = 'CMD|SHIFT',
    action = wezterm.action.ReloadConfiguration
  }
}

return config
