flavor ?= Mocha
lowercase = $(shell echo $(1) | tr '[:upper:]' '[:lower:]')

.PHONY: install symlinks vscode-extensions vscode helix fonts catppuccin

install:
	@if [ ! -f $(HOME)/.zshrc ] && [ ! -L $(HOME)/.zshrc ]; then ln -s $(PWD)/zsh/.zshrc $(HOME)/.zshrc; fi
	@brew --version || sh -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
	@brew bundle
	@ln -s $(PWD)/delta/.gitconfig ${HOME}/.gitconfig
	@sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
	@curl -L https://sw.kovidgoyal.net/kitty/installer.sh | sh /dev/stdin
	make helix

symlinks:
	ln -s $(PWD)/.vscode-oss ${HOME}/.vscode-oss
	ln -s $(PWD)/zsh/.zshrc ${HOME}/.zshrc

vscode-extensions:
	@test -d "~/.vscode-oss" || ln -s $(PWD)/.vscode-oss ~/.vscode-oss
	@cat ~/.vscode-oss/extensions.txt | xargs -L 1 codium --install-extension

vscode:
	ln -s $(XDG_CONFIG_HOME)/.vscode-oss ~/.vscode-oss
	brew install --cask vscodium
	rm -rf ~/Library/Application\ Support/VSCodium/User
	ln -s ~/.vscode-oss/User ~/Library/Application\ Support/VSCodium/User
	cat .vscode-oss/extensions.txt | xargs -L 1 codium --install-extension

helix:
	@git clone https://github.com/helix-editor/helix helix-code
	@mkdir -p $(PWD)/helix
	@cp -R $(PWD)/helix-code/* $(PWD)/helix/
	@rm -rf $(PWD)/helix-code
	@cd helix && rm -rf .git
	@echo "Building Helix"
	@curl https://sh.rustup.rs -sSf | sh
	@source ~/.cargo/env
	@cd helix && export HELIX_DISABLE_AUTO_GRAMMAR_BUILD=1 && cargo install --path helix-term --locked
	@hx --health
	@echo "🎨 Installing Catppuccin 🎨"
	@cd helix && [ ! -d "catppuccin" ] && \
		git clone git@github.com:catppuccin/helix.git catppuccin && \
		cd catppuccin && rm -rf .git || \
		echo "✅ Catppuccin already installed"
	@launchctl setenv EDITOR ~/.cargo/bin/hx
	@echo "🚀 Helix installation completed successfully!! 🚀"
	@echo "Building grammars!"
	@hx --grammar fetch && hx --grammar build

fonts:
	@git clone git@github.com:silverhairs/fonts.git
	@echo "installing fonts..." && \
		find ./fonts -type f \( -name "*.ttf" -o -name "*.otf" -o -name "*.woff" -o -name "*.woff2" -o -name "*.eot" \) \
		-exec cp {} ~/Library/Fonts/ \; -exec echo {} \;
	@rm -rf fonts
	@echo "Fonts installed, You are all set!"

catppuccin:
	@echo "Setting Catppuccin $(flavor) as theme for kitty..." && \
		kitty +kitten themes --reload-in=all Catppuccin-$(flavor) && \
		echo "Setting Catppuccin $(flavor) as theme for bat..." && bat cache --build && \
			gsed -i '/theme/c\--theme="Catppuccin $(flavor)"' ~/.config/bat/config && \
			echo "Setting catppuccin_$(call lowercase, $(flavor)) as theme for helix..." && \
				gsed -i '/theme =/c\theme = "catppuccin_$(call lowercase, $(flavor))"' ~/.config/helix/config.toml && \
				echo "Setting Catppuccin $(flavor) as theme for VSCodium..." && \
					gsed -i '/workbench.colorTheme/c\"workbench.colorTheme": "Catppuccin $(flavor)",' ~/.config/.vscode-oss/User/settings.json && \
					echo "Setting catppuccin-$(call lowercase, $(flavor)) as theme for delta..." && \
						gsed -i '/features/c\\tfeatures = catppuccin-$(call lowercase, $(flavor))' ~/.config/delta/.gitconfig && \
						echo "Setting catppuccin-$(flavor) as theme for Ghostty..." && \
							gsed -i '/theme =/c\theme = "catppuccin-$(call lowercase, $(flavor))"' ~/.config/ghostty/config && \
							echo "You are all set! 🚀"
						
