# .config

Personal macOS dotfiles and development environment setup using Homebrew, zsh, and carefully curated tools.

## ✨ Features

- **🎨 Consistent theming** - Catppuccin theme across all tools (Kitty, Helix, VSCode, etc.)
- **⚡ Modern CLI tools** - Replaces traditional tools with faster, better alternatives
- **🔧 Development ready** - Pre-configured for Flutter, Rust, Go, Python, Node.js, and more
- **🪟 Window management** - Yabai + skhd for tiling window management
- **📝 Powerful editor** - Helix with LSP support and syntax highlighting
- **🚀 Optimized workflow** - Aliases, shortcuts, and automation for common tasks

## 🚀 Quick Start

```bash
git clone https://github.com/silverhairs/.config.git ~/.config
cd ~/.config
make install
```

This will install and configure:
- **116 CLI tools** via Homebrew
- **30 GUI applications** 
- **Development environments** for multiple languages
- **Custom themes and fonts**
- **Window management system**

## 🛠 Key Tools Installed

### Core System
- [Homebrew](https://brew.sh/) - Package manager
- [oh-my-zsh](https://github.com/ohmyzsh/ohmyzsh) - Zsh framework
- [Kitty](https://github.com/kovidgoyal/kitty) - GPU-accelerated terminal
- [Yabai](https://github.com/koekeishiya/yabai) + [skhd](https://github.com/koekeishiya/skhd) - Window management

### Development
- [Helix](https://github.com/helix-editor/helix) - Modal text editor with LSP
- [Lazygit](https://github.com/jesseduffield/lazygit) - Terminal Git UI
- [Git Delta](https://github.com/dandavison/delta) - Syntax-highlighted diffs
- [FVM](https://github.com/leoafarias/fvm) - Flutter version management

### Modern CLI Replacements
- `eza` → `ls` (better file listing)
- `bat` → `cat` (syntax highlighting)
- `btop` → `htop` (system monitor)
- `zoxide` → `cd` (smart directory jumping)
- `ripgrep` → `grep` (faster searching)
- `fd` → `find` (intuitive file finding)

## 📋 Available Commands

```bash
make help              # Show all available targets
make install           # Full system setup
make install-dotfiles  # Symlink dotfiles only
make install-githooks  # One-time per machine: run hooks on pull (e.g. keep omnisharp-lsp symlinked)
make catppuccin        # Apply Catppuccin theme
make clean             # Remove temporary files
```

### Multi-machine setup

When you use this repo on more than one computer, run **once per machine**:

```bash
make install-githooks
```

This configures git to use the repo’s `.githooks`. After that, every `git pull` runs a post-merge hook that ensures each entry in `scripts/bin-symlinks.txt` is symlinked from `~/.local/bin` into this repo (e.g. `omnisharp-lsp` for Helix). `make install-dotfiles` also creates those symlinks.

### Theme Variants
```bash
make catppuccin flavor=Mocha      # Dark theme (default)
make catppuccin flavor=Latte      # Light theme
make catppuccin flavor=Frappe     # Medium theme
make catppuccin flavor=Macchiato  # Dark theme variant
```

## 🎯 Language Support

Pre-configured development environments for:

- **Flutter/Dart** - FVM, pub cache, Android SDK
- **Rust** - rustup, cargo, language server
- **Go** - gopls, migrate tools
- **Python** - Multiple versions (3.11, 3.12), uv package manager
- **Node.js** - pnpm, language servers
- **Java** - OpenJDK 11, 17, 21, Kotlin LSP
- **PHP** - PHP 8.2, PHPStan, language server

## 🔧 Configuration Structure

```
~/.config/
├── zsh/           # Shell configuration and aliases
├── kitty/         # Terminal emulator config
├── helix/         # Text editor configuration
├── yabai/         # Window manager rules
├── skhd/          # Keyboard shortcuts
├── git/           # Git configuration with Delta
├── tmux/          # Terminal multiplexer
├── lazygit/       # Git UI configuration
└── ...            # Other tool configurations
```

## 🎨 Theming

All tools are configured with consistent Catppuccin theming:
- Terminal (Kitty)
- Editor (Helix)
- File viewer (bat)
- Git diffs (Delta)
- Code editor (VSCode/VSCodium)

## 📦 Requirements

- **macOS** (tested on recent versions)
- **Internet connection** (for downloading packages)
- **Git** (usually pre-installed)

The Makefile will automatically install Homebrew if not present.

## 🔄 Updating

```bash
cd ~/.config
git pull
make install  # Re-run to update configurations
```

## 🎯 Useful Aliases

- `lg` - Launch Lazygit
- `ls` - Enhanced file listing with icons
- `img` - View images in terminal
- `work` - Launch work session
- `coverage` - Generate HTML coverage reports

## 🤝 Contributing

Feel free to fork and customize for your own setup. The configuration is modular and easy to modify.

## 📄 License

Personal dotfiles - use at your own discretion.
