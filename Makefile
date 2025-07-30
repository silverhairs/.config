flavor ?= Mocha
lowercase = $(shell echo $(1) | tr '[:upper:]' '[:lower:]')

.PHONY: install install-dotfiles install-brew install-ohmyzsh install-kitty install-helix install-fonts install-themes symlinks vscode-extensions vscode catppuccin fonts helix clean help

# Default target with help
help:
	@echo "Available targets:"
	@echo "  install          - Full system setup"
	@echo "  install-dotfiles - Symlink dotfiles only"
	@echo "  install-brew     - Install Homebrew packages"
	@echo "  install-helix    - Install and configure Helix editor"
	@echo "  catppuccin       - Apply Catppuccin theme (flavor=$(flavor))"
	@echo "  clean            - Remove temporary files"
	@echo "  help             - Show this help"

install: install-dotfiles install-brew install-ohmyzsh install-kitty install-helix install-fonts install-themes

install-dotfiles:
	@echo "Symlinking dotfiles..."
	@set -e; \
	if [ ! -f $(HOME)/.zshrc ] && [ ! -L $(HOME)/.zshrc ]; then \
		ln -s $(PWD)/zsh/.zshrc $(HOME)/.zshrc && echo "✓ Linked .zshrc"; \
	else \
		echo "✓ .zshrc already exists"; \
	fi; \
	if [ ! -f $(HOME)/.gitconfig ] && [ ! -L $(HOME)/.gitconfig ]; then \
		ln -s $(PWD)/delta/.gitconfig $(HOME)/.gitconfig && echo "✓ Linked .gitconfig"; \
	else \
		echo "✓ .gitconfig already exists"; \
	fi

install-brew:
	@echo "Setting up Homebrew..."
	@set -e; \
	if ! command -v brew >/dev/null 2>&1; then \
		echo "Installing Homebrew..."; \
		/bin/bash -c "$$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; \
	else \
		echo "✓ Homebrew already installed"; \
	fi; \
	echo "Running brew bundle..."; \
	brew bundle

install-ohmyzsh:
	@echo "Setting up oh-my-zsh..."
	@set -e; \
	if [ ! -d $(HOME)/.oh-my-zsh ]; then \
		echo "Installing oh-my-zsh..."; \
		RUNZSH=no sh -c "$$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"; \
		echo "✓ oh-my-zsh installed"; \
	else \
		echo "✓ oh-my-zsh already installed"; \
	fi

install-kitty:
	@echo "Setting up Kitty..."
	@set -e; \
	if ! command -v kitty >/dev/null 2>&1; then \
		echo "Installing Kitty..."; \
		curl -L https://sw.kovidgoyal.net/kitty/installer.sh | sh /dev/stdin; \
		echo "✓ Kitty installed"; \
	else \
		echo "✓ Kitty already installed"; \
	fi

install-helix: helix

helix:
	@echo "Setting up Helix editor..."
	@set -e; \
	if ! command -v hx >/dev/null 2>&1; then \
		echo "Installing Rust if needed..."; \
		if ! command -v cargo >/dev/null 2>&1; then \
			curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y; \
		fi; \
		echo "Cloning Helix repository..."; \
		if [ -d "helix-temp" ]; then rm -rf helix-temp; fi; \
		git clone https://github.com/helix-editor/helix helix-temp; \
		mkdir -p $(PWD)/helix; \
		cp -R helix-temp/* $(PWD)/helix/; \
		rm -rf helix-temp; \
		cd helix && rm -rf .git; \
		echo "Building Helix..."; \
		export PATH="$$HOME/.cargo/bin:$$PATH"; \
		cd helix && HELIX_DISABLE_AUTO_GRAMMAR_BUILD=1 cargo install --path helix-term --locked; \
		echo "Installing Catppuccin theme..."; \
		if [ ! -d "$(PWD)/helix/catppuccin" ]; then \
			git clone https://github.com/catppuccin/helix.git $(PWD)/helix/catppuccin; \
			cd $(PWD)/helix/catppuccin && rm -rf .git; \
		fi; \
		echo "Setting up grammars..."; \
		$$HOME/.cargo/bin/hx --grammar fetch && $$HOME/.cargo/bin/hx --grammar build; \
		echo "✓ Helix installation completed"; \
	else \
		echo "✓ Helix already installed"; \
	fi

install-fonts: fonts

fonts:
	@echo "Installing fonts..."
	@set -e; \
	if [ -d "fonts-temp" ]; then rm -rf fonts-temp; fi; \
	git clone https://github.com/silverhairs/fonts.git fonts-temp; \
	echo "Copying fonts to ~/Library/Fonts/..."; \
	find ./fonts-temp -type f \( -name "*.ttf" -o -name "*.otf" -o -name "*.woff" -o -name "*.woff2" -o -name "*.eot" \) \
		-exec cp {} ~/Library/Fonts/ \; 2>/dev/null || true; \
	rm -rf fonts-temp; \
	echo "✓ Fonts installed"

install-themes:
	@echo "Setting up themes..."
	@$(MAKE) catppuccin

symlinks:
	@echo "Creating additional symlinks..."
	@set -e; \
	if [ ! -L $(HOME)/.vscode-oss ]; then \
		ln -s $(PWD)/.vscode-oss $(HOME)/.vscode-oss; \
		echo "✓ Linked .vscode-oss"; \
	else \
		echo "✓ .vscode-oss already linked"; \
	fi

vscode-extensions:
	@echo "Installing VSCode extensions..."
	@set -e; \
	if [ ! -d $(HOME)/.vscode-oss ]; then \
		ln -s $(PWD)/.vscode-oss $(HOME)/.vscode-oss; \
	fi; \
	if command -v codium >/dev/null 2>&1 && [ -f ~/.vscode-oss/extensions.txt ]; then \
		cat ~/.vscode-oss/extensions.txt | xargs -L 1 codium --install-extension; \
		echo "✓ Extensions installed"; \
	else \
		echo "⚠ VSCodium not found or extensions.txt missing"; \
	fi

vscode:
	@echo "Setting up VSCodium..."
	@set -e; \
	if [ -n "$(XDG_CONFIG_HOME)" ]; then \
		ln -sf $(XDG_CONFIG_HOME)/.vscode-oss $(HOME)/.vscode-oss; \
	else \
		ln -sf $(PWD)/.vscode-oss $(HOME)/.vscode-oss; \
	fi; \
	if ! command -v codium >/dev/null 2>&1; then \
		brew install --cask vscodium; \
	fi; \
	rm -rf ~/Library/Application\ Support/VSCodium/User; \
	ln -s ~/.vscode-oss/User ~/Library/Application\ Support/VSCodium/User; \
	$(MAKE) vscode-extensions

catppuccin:
	@echo "Applying Catppuccin $(flavor) theme..."
	@set -e; \
	echo "→ Setting theme for Kitty..."; \
	if command -v kitty >/dev/null 2>&1; then \
		kitty +kitten themes --reload-in=all Catppuccin-$(flavor) 2>/dev/null || echo "⚠ Kitty theme not applied"; \
	fi; \
	echo "→ Setting theme for bat..."; \
	if command -v bat >/dev/null 2>&1; then \
		bat cache --build >/dev/null 2>&1 || true; \
		if [ -f ~/.config/bat/config ]; then \
			gsed -i '/theme/c\--theme="Catppuccin $(flavor)"' ~/.config/bat/config 2>/dev/null || true; \
		fi; \
	fi; \
	echo "→ Setting theme for Helix..."; \
	if [ -f ~/.config/helix/config.toml ]; then \
		gsed -i '/theme =/c\theme = "catppuccin_$(call lowercase, $(flavor))"' ~/.config/helix/config.toml 2>/dev/null || true; \
	fi; \
	echo "→ Setting theme for VSCodium..."; \
	if [ -f ~/.config/.vscode-oss/User/settings.json ]; then \
		gsed -i '/workbench.colorTheme/c\"workbench.colorTheme": "Catppuccin $(flavor)",' ~/.config/.vscode-oss/User/settings.json 2>/dev/null || true; \
	fi; \
	echo "→ Setting theme for Delta..."; \
	if [ -f ~/.config/delta/.gitconfig ]; then \
		gsed -i '/features/c\\tfeatures = catppuccin-$(call lowercase, $(flavor))' ~/.config/delta/.gitconfig 2>/dev/null || true; \
	fi; \
	echo "→ Setting theme for Ghostty..."; \
	if [ -f ~/.config/ghostty/config ]; then \
		gsed -i '/theme =/c\theme = "catppuccin-$(call lowercase, $(flavor))"' ~/.config/ghostty/config 2>/dev/null || true; \
	fi; \
	echo "✓ Catppuccin $(flavor) theme applied"

clean:
	@echo "Cleaning up temporary files..."
	@rm -rf helix-temp fonts-temp helix-code fonts 2>/dev/null || true
	@echo "✓ Cleanup completed"