.PHONY: install

install:
	-brew bundle
	sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
	curl -L https://sw.kovidgoyal.net/kitty/installer.sh | sh /dev/stdin
