.PHONY: install symlinks vscode-extensions vscode helix

install:
	-brew bundle
	sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
	curl -L https://sw.kovidgoyal.net/kitty/installer.sh | sh /dev/stdin

symlinks:
	ln -s ./.vscode-oss ~/.vscode-oss
	ln -s ./zsh/.zshrc ~/.zshrc

vscode-extensions:
	cat .vscode-oss/extensions.txt | xargs -L 1 codium --install-extension

vscode:
	ln -s ./.vscode-oss ~/.vscode-oss
	brew install --cask vscodium
	cp -R ./.vscode-oss/User ~/Library/Application\ Support/VSCodium/User
	cat .vscode-oss/extensions.txt | xargs -L 1 codium --install-extension

helix:
	@git clone https://github.com/helix-editor/helix helix-code
	@mkdir -p $(PWD)/helix
	@cp -R $(PWD)/helix-code/* $(PWD)/helix/
	@cd helix && rm -rf .git
	@echo "Building Helix"
	@cd helix && export HELIX_DISABLE_AUTO_GRAMMAR_BUILD=1 && cargo install --path helix-term --locked
	@hx --health
	@echo "Installing Catppuccin"
	@cd helix && git clone git@github.com:catppuccin/helix.git catppuccin && cd catppuccin && rm -rf .git
