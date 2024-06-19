.PHONY: install symlinks vscode-extensions vscode helix

install:
	@test -d "~/.zshrc" || ln -s $(PWD)/zsh/.zshrc ~/.zshrc
	@brew --version || sh -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
	-brew bundle
	@sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
	curl -L https://sw.kovidgoyal.net/kitty/installer.sh | sh /dev/stdin
	make helix

symlinks:
	ln -s $(PWD)/.vscode-oss ${HOME}/.vscode-oss
	ln -s $(PWD)/zsh/.zshrc ${HOME}/.zshrc

vscode-extensions:
	@test -d "~/.vscode-oss" || ln -s $(PWD)/.vscode-oss ~/.vscode-oss
	@cat ~/.vscode-oss/extensions.txt | xargs -L 1 codium --install-extension

vscode:
	ln -s $(PWD)/.vscode-oss ${HOME}/.vscode-oss
	brew install --cask vscodium
	cp -R $(PWD)/.vscode-oss/User ~/Library/Application\ Support/VSCodium/User
	cat .vscode-oss/extensions.txt | xargs -L 1 codium --install-extension

helix:
	@git clone https://github.com/helix-editor/helix helix-code
	@mkdir -p $(PWD)/helix
	@cp -R $(PWD)/helix-code/* $(PWD)/helix/
	@rm -rf $(PWD)/helix-code
	@cd helix && rm -rf .git
	@echo "Building Helix"
	@cd helix && export HELIX_DISABLE_AUTO_GRAMMAR_BUILD=1 && cargo install --path helix-term --locked
	@hx --health
	@echo "🎨 Installing Catppuccin 🎨"
	@cd helix && [ ! -d "catppuccin" ] && \
		git clone git@github.com:catppuccin/helix.git catppuccin && \
		cd catppuccin && rm -rf .git || \
		echo "✅ Catppuccin already installed"
	@echo "🚀 Helix installation completed successfully!! 🚀"
