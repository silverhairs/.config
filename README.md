# .config

Personal MacOS dotfiles based on Homebrew and zsh.

## Getting Started
All you need to know is written in the Makefile

```sh
$ make install
```
This command will install the packages below in your system:
- [x] [zoxide](https://github.com/ajeetdsouza/zoxide)
- [x] [yabai](https://github.com/koekeishiya/yabai)
- [x] [skhd](https://github.com/koekeishiya/skhd)
- [x] [kitty](https://github.com/kovidgoyal/kitty)
- [x] [gh](https://cli.github.com/)
- [x] [thefuck](https://github.com/nvbn/thefuck)
- [x] [fig](https://fig.io/)
- [x] [raycast](https://www.raycast.com/)
- [x] [ohmyzsh](https://github.com/ohmyzsh/ohmyzsh)
- [x] [helix](https://github.com/helix-editor/helix)

After the command is done, you can symlink the `/zsh/.zshrc` with the path where
your zshrc file lives (usually at `~/.zsrhc`)

```sh
ln -s zsh/.zshrc ~/.zshrc
```

Note that by default, Homebrew will be used as a package manager, unless a package is not hosted on homebrew, the `install` command will install it from homebrew.

## Requirements:
- [Homebrew](https://brew.sh/)
- [curl](https://curl.se/)
