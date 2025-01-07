# Q pre block. Keep at the top of this file.
# If you come from bash you might have to change your $PATH.
# export PATH=$HOME/bin:/usr/local/bin:$PATH

export PATH="/opt/homebrew/bin:$PATH"
export PATH="/opt/homebrew/opt/openssl@3.0/bin:$PATH"

# export LDFLAGS="-L/opt/homebrew/opt/openssl@3.0/lib"
# export CPPFLAGS="-I/opt/homebrew/opt/openssl@3.0/include"

export _ZO_DATA_DIR="/Users/${USER}/.local/share"
export XDG_CONFIG_HOME="$HOME/.config"

# Path to Flutter and dart
export PATH="$PATH:/Users/${USER}/fvm/default/bin"
export PATH="$PATH":"$HOME/.pub-cache/bin"
export PATH="$PATH:/Users/${USER}/.gem/bin"
export PATH="$PATH":"$HOME/zig"
export PATH="$PATH:/opt/homebrew/opt/llvm/bin"
export PATH="$PATH:/opt/homebrew/anaconda3/bin"

# Android
export PATH="$PATH:/Users/${USER}/Library/Android/sdk/platform-tools/"
export GEM_HOME="$HOME/.gem"
# Python
export PATH="$PATH:/Users/${USER}/Library/Python/3.9/bin"
export HELIX_RUNTIME="~/.config/helix/runtime"
export EDITOR="hx"
export DELTA_PAGER="less -F -S -R -i -+X"
export TMUX_CONF=~/.config/tmux/.tmux.conf

# Java and android studio
export JAVA_HOME="$HOME/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"

export HOMEBREW_NO_ENV_HINTS=0
export PATH="/opt/homebrew/opt/vim/bin:$PATH"

source ~/.config/zsh/.zsh-alias
source /opt/homebrew/opt/chruby/share/chruby/chruby.sh
source /opt/homebrew/opt/chruby/share/chruby/auto.sh
source $HOME/.zsh_SECRETS
source $(brew --prefix)/share/zsh-autosuggestions/zsh-autosuggestions.zsh

eval "$(zoxide init --cmd cd zsh)"
eval "$(thefuck --alias)"
eval "$(rbenv init -)"
eval "$(fzf --zsh)"
eval "$(starship init zsh)"

## [Completion] 
## Completion scripts setup. Remove the following line to uninstall
[[ -f /Users/${USER}/.dart-cli-completion/zsh-config.zsh ]] && . /Users/${USER}/.dart-cli-completion/zsh-config.zsh || true
## [/Completion]

# opam configuration
[[ ! -r /Users/${USER}/.opam/opam-init/init.zsh ]] || source /Users/${USER}/.opam/opam-init/init.zsh  > /dev/null 2> /dev/null
