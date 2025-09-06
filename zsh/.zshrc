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
export DELTA_PAGER="less -F -S -R -i -+X --mouse"
export PAGER="bat --paging=always"
export TMUX_CONF=~/.config/tmux/.tmux.conf

# Java and android studio
export PATH="/opt/homebrew/opt/openjdk@17/bin:$PATH"
export CPPFLAGS="-I/opt/homebrew/opt/openjdk@17/include"
export JAVA_HOME="/opt/homebrew/opt/openjdk@17"
export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"

export PATH="/opt/homebrew/opt/php@8.2/bin:$PATH"
export PATH="/opt/homebrew/opt/php@8.2/sbin:$PATH"

export HOMEBREW_NO_ENV_HINTS=1
export PATH="/opt/homebrew/opt/vim/bin:$PATH"


# Carapace completions
autoload -U +X compinit && compinit
autoload -U +X bashcompinit && bashcompinit
# export CARAPACE_BRIDGES='zsh,fish,bash,inshellisense' # optional
# zstyle ':completion:*' format $'\e[2;37mCompleting %d\e[m'
# source <(carapace _carapace)


source ~/.config/zsh/.zsh-alias
source /opt/homebrew/opt/chruby/share/chruby/chruby.sh
source /opt/homebrew/opt/chruby/share/chruby/auto.sh
source $HOME/.zsh_SECRETS
source $(brew --prefix)/share/zsh-autosuggestions/zsh-autosuggestions.zsh

eval "$(zoxide init --cmd cd zsh)"
eval "$(thefuck --alias)"
eval "$(rbenv init -)"
eval "$(fzf --zsh)"
eval "$(oh-my-posh init zsh --config ~/.config/omp.json)"

## [Completion]
## Completion scripts setup. Remove the following line to uninstall
[[ -f /Users/${USER}/.dart-cli-completion/zsh-config.zsh ]] && . /Users/${USER}/.dart-cli-completion/zsh-config.zsh || true
## [/Completion]

# opam configuration
[[ ! -r /Users/${USER}/.opam/opam-init/init.zsh ]] || source /Users/${USER}/.opam/opam-init/init.zsh >/dev/null 2>/dev/null

. "$HOME/.local/bin/env"

#THIS MUST BE AT THE END OF THE FILE FOR SDKMAN TO WORK!!!
export SDKMAN_DIR="$HOME/.sdkman"
[[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ]] && source "$HOME/.sdkman/bin/sdkman-init.sh"
