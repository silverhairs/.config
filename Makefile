.PHONY: install symlinks vscode-extensions

install:
	-brew bundle
	sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
	curl -L https://sw.kovidgoyal.net/kitty/installer.sh | sh /dev/stdin

symlinks:
	ln -s .vscode-oss ~/.vscode-oss
	ln -s zsh/.zshrc ~/.zshrc

vscode-extensions:
	cat .vscode-oss/extensions.txt | xargs -L 1 code --install-extension

vscode:
	ln -s .vscode-oss ~/.vscode-oss
	brew install --cask vscodium
	make vscode-extensions
