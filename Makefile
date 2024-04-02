.PHONY: install symlinks vscode-extensions vscode

install:
	-brew bundle
	sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
	curl -L https://sw.kovidgoyal.net/kitty/installer.sh | sh /dev/stdin

symlinks:
	ln -s $(PWD)/.vscode-oss ~/.vscode-oss
	ln -s zsh/.zshrc ~/.zshrc

vscode-extensions:
	cat .vscode-oss/extensions.txt | xargs -L 1 codium --install-extension

vscode:
	ln -s $(PWD)/.vscode-oss ~/.vscode-oss
	brew install --cask vscodium
	cp -R $(PWD)/.vscode-oss/User ~/Library/Application\ Support/VSCodium/User
	cat .vscode-oss/extensions.txt | xargs -L 1 codium --install-extension
