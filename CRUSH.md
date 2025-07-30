# CRUSH.md - Development Guide

## Build/Install Commands
- `make install` - Full system setup (Homebrew, oh-my-zsh, dotfiles, themes)
- `make install-dotfiles` - Symlink dotfiles only
- `make catppuccin` - Apply Catppuccin theme across all tools
- `brew bundle` - Install packages from Brewfile

## Development Tools
- **Editor**: Helix (`hx`) - primary editor with LSP support
- **Terminal**: Kitty with tmux sessions
- **Git UI**: Lazygit (`lg` alias)
- **File Manager**: Yazi with image preview
- **Shell**: zsh with oh-my-zsh, zoxide, and autosuggestions

## Code Style & Conventions
- **Themes**: Catppuccin (Mocha/Frappe) or Gruvbox Dark across all tools
- **Line endings**: Unix (LF) preferred
- **Indentation**: Follow language-specific conventions (2/4 spaces, tabs where appropriate)
- **File organization**: Use XDG Base Directory specification (`~/.config/`)

## Language-Specific Setup
- **Flutter/Dart**: Use FVM (`fvm flutter`, `fvm dart`)
- **Python**: Use uv for dependency management (`uv run`, `uvr` alias)
- **Java**: OpenJDK 17 (JAVA_HOME set)
- **Node**: Use pnpm for package management
- **Rust**: Managed via rustup

## Aliases & Shortcuts
- `lg` - lazygit
- `ls` - eza with icons and git status
- `img` - kitty image viewer
- `coverage` - generate and open HTML coverage report
- `work` - launch work session in background

## Testing & Quality
- Use language-specific test runners (check project for `package.json`, `Cargo.toml`, etc.)
- Coverage reports: `coverage` alias for HTML generation
- Linting: Configured per-language in respective config files